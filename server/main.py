import os
import tempfile
import zipfile
import shutil
import json
import fitz  # PyMuPDF
from io import BytesIO
from typing import List
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from workflow_lib import ConsentExtractor, SitePlanLocator, PDFProcessor, ExcelWriter
# Add current directory to sys.path to ensure workflow_lib is found if run from elsewhere
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

app = FastAPI(title="Wayleave Automation API")

# Enable CORS for React dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Wayleave Automation API is running"}

@app.post("/extract")
async def extract_documents(
    files: List[UploadFile] = File(...),
):
    extractor = ConsentExtractor()
    all_results = []
    
    # Store temp files to process
    temp_files = []
    try:
        for file in files:
            suffix = os.path.splitext(file.filename)[1]
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                shutil.copyfileobj(file.file, tmp)
                temp_files.append({"name": file.filename, "path": tmp.name})
        
        # We can use ThreadPoolExecutor here for parallel extraction if needed, 
        # but for now, let's keep it simple or reuse the logic.
        # Note: ConsentExtractor.extract_details is a generator.
        
        for item in temp_files:
            for page_num, data in extractor.extract_details(item["path"]):
                if data:
                    row_id = f"{item['name']}_p{page_num}"
                    data["_id"] = row_id
                    data["_file_name"] = item["name"]
                    data["_page_num"] = page_num
                    # We also need the file content later, but for now we'll just store the path
                    # Actually, for a stateless API, we might need a better way.
                    # But since this is a local-ish tool, we can store in a global dict or temp dir.
                    all_results.append(data)
                    
        return {"results": all_results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        # Note: In a real app we'd clean up, but we need these files for finalization?
        # Better strategy: Frontend sends the files back or we use a session-based storage.
        # For this demo, let's assume we clean up and the frontend sends files per request.
        for item in temp_files:
            if os.path.exists(item["path"]):
                # On Windows, file handles can take a moment to release.
                # Adding a small retry loop for deletion.
                import time
                for i in range(3):
                    try:
                        os.remove(item["path"])
                        break
                    except PermissionError:
                        if i < 2:
                            time.sleep(0.3)
                        else:
                            print(f"    [Cleanup Warning] Could not delete temp file {item['path']}: Access Denied")
                    except Exception as e:
                        print(f"    [Cleanup Warning] Error deleting {item['path']}: {e}")
                        break

@app.post("/finalize")
async def finalize_project(
    background_tasks: BackgroundTasks,
    extraction_results: str = Form(...),
    site_plan: UploadFile = File(...),
    excel_template: UploadFile = File(...),
    consent_pdfs: List[UploadFile] = File(...)
):
    """
    Combines everything: 
    1. Re-processes the extraction results (which might be edited).
    2. Matches against site plan.
    3. Overlays snippets.
    4. Updates Excel.
    5. Returns a ZIP containing everything.
    """
    try:
        results = json.loads(extraction_results)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid extraction_results JSON")

    temp_dir = tempfile.mkdtemp()
    
    try:
        # Save site plan
        site_plan_path = os.path.join(temp_dir, "master_site_plan.pdf")
        with open(site_plan_path, "wb") as f:
            shutil.copyfileobj(site_plan.file, f)
        
        # Save excel template
        excel_path = os.path.join(temp_dir, "template.xlsx")
        with open(excel_path, "wb") as f:
            shutil.copyfileobj(excel_template.file, f)
            
        # Save consent PDFs (to use during overlay)
        consent_map = {}
        for c_pdf in consent_pdfs:
            c_path = os.path.join(temp_dir, c_pdf.filename)
            with open(c_path, "wb") as f:
                shutil.copyfileobj(c_pdf.file, f)
            consent_map[c_pdf.filename] = c_path

        # Initialize Locator
        locator = SitePlanLocator(site_plan_path)
        
        output_zip_path = os.path.join(temp_dir, "results.zip")
        output_excel_buffer = BytesIO()
        
        with zipfile.ZipFile(output_zip_path, "w", zipfile.ZIP_DEFLATED) as zip_file:
            for row in results:
                name = row.get("Signed by") or row.get("proprietor_name")
                title = row.get("Plot No") or row.get("title_number")
                box = row.get("sketch_box_1000")
                f_name = row.get("_file_name")
                p_num = row.get("_page_num")
                temp_path = consent_map.get(f_name)

                if name and box and temp_path:
                    match = locator.search(name, title)
                    if match:
                        snip_path = os.path.join(temp_dir, f"snip_{row['_id']}.png")
                        out_pdf_path = os.path.join(temp_dir, f"proc_{row['_id']}.pdf")
                        
                        box_w = box[3] - box[1]
                        box_h = box[2] - box[0]
                        aspect_ratio = box_w / box_h if box_h != 0 else 1.0
                        
                        locator.get_snippet(match, snip_path, aspect_ratio=aspect_ratio)
                        success = PDFProcessor.overlay_snippet(temp_path, snip_path, box, out_pdf_path, page_index=p_num, rotation=row.get("rotation", 0))
                        
                        if success and os.path.exists(out_pdf_path):
                            safe_title = str(title).replace('/', '_').replace('\\', '_')
                            zip_name = f"{os.path.splitext(f_name)[0]}_P{p_num+1}_{safe_title}.pdf"
                            zip_file.write(out_pdf_path, zip_name)
            
            # Update Excel Template
            with open(excel_path, "rb") as f:
                ExcelWriter.append_data(f, results, output_excel_buffer)
            
            # Add Excel to ZIP
            zip_file.writestr("Wayleave_Master_List_Updated.xlsx", output_excel_buffer.getvalue())

        # Clean up locator document
        locator.close()

        # Schedule cleanup of the entire temp directory
        background_tasks.add_task(shutil.rmtree, temp_dir)

        return FileResponse(
            output_zip_path, 
            media_type="application/zip", 
            filename="Wayleave_Automation_Results.zip"
        )

    except Exception as e:
        import traceback
        error_msg = f"Finalization Error: {str(e)}\n{traceback.format_exc()}"
        print(error_msg)
        if 'temp_dir' in locals() and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)
        raise HTTPException(status_code=500, detail=error_msg)

@app.post("/preview")
async def get_preview(
    file: UploadFile = File(...),
    page_num: int = Form(...)
):
    try:
        suffix = os.path.splitext(file.filename)[1]
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp_path = tmp.name
        
        try:
            doc = fitz.open(tmp_path)
            if page_num < 0 or page_num >= len(doc):
                doc.close()
                raise HTTPException(status_code=400, detail=f"Page number {page_num} out of range (0-{len(doc)-1})")
            
            page = doc[page_num]
            pix = page.get_pixmap(dpi=150)
            img_data = pix.tobytes("png")
            doc.close()
            return Response(content=img_data, media_type="image/png")
        except Exception as e:
            if 'doc' in locals(): doc.close()
            raise HTTPException(status_code=500, detail=f"Preview Render Error: {str(e)}")
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
