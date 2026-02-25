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

# Global registry for temporary downloads (used in local tool context)
DOWNLOAD_REGISTRY = {}

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Wayleave Automation API is running"}

@app.post("/extract")
async def extract_documents(
    files: List[UploadFile] = File(...),
):
    from fastapi.responses import StreamingResponse
    import asyncio
    
    extractor = ConsentExtractor()
    
    async def event_generator():
        temp_files = []
        try:
            # Prepare all files first
            for file in files:
                suffix = os.path.splitext(file.filename)[1]
                with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                    shutil.copyfileobj(file.file, tmp)
                    temp_files.append({"name": file.filename, "path": tmp.name})
            
            for item in temp_files:
                # Yield filename for context
                yield json.dumps({"type": "file_start", "filename": item["name"]}) + "\n"
                
                # extractor.extract_details is now yielding (page_num, event_dict)
                for page_num, event in extractor.extract_details(item["path"]):
                    if event["type"] == "data":
                        # Enrich data with metadata
                        data = event["data"]
                        data["_id"] = f"{item['name']}_p{page_num}"
                        data["_file_name"] = item["name"]
                        data["_page_num"] = page_num
                        event["data"] = data
                    
                    yield json.dumps(event) + "\n"
                    # Small sleep to ensure the message is flushed and UI can keep up
                    await asyncio.sleep(0.01)

            yield json.dumps({"type": "complete"}) + "\n"
            
        except Exception as e:
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"
        finally:
            # Robust cleanup
            for item in temp_files:
                if os.path.exists(item["path"]):
                    for i in range(3):
                        try:
                            os.remove(item["path"])
                            break
                        except PermissionError:
                            await asyncio.sleep(0.5)
                        except Exception:
                            break

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")

@app.post("/finalize")
async def finalize_project(
    background_tasks: BackgroundTasks,
    extraction_results: str = Form(...),
    site_plan: UploadFile = File(...),
    excel_template: UploadFile = File(...),
    consent_pdfs: List[UploadFile] = File(...)
):
    from fastapi.responses import StreamingResponse
    import asyncio
    import uuid
    
    try:
        results_list = json.loads(extraction_results)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid extraction_results JSON")
    
    async def event_generator():
        temp_dir = tempfile.mkdtemp()
        file_id = str(uuid.uuid4())
        try:
            yield json.dumps({"type": "status", "message": "Preparing files..."}) + "\n"
            
            # Save files to temp dir
            site_plan_path = os.path.join(temp_dir, "master_site_plan.pdf")
            with open(site_plan_path, "wb") as f:
                shutil.copyfileobj(site_plan.file, f)
            
            excel_path = os.path.join(temp_dir, "template.xlsx")
            with open(excel_path, "wb") as f:
                shutil.copyfileobj(excel_template.file, f)
                
            consent_map = {}
            for c_pdf in consent_pdfs:
                c_path = os.path.join(temp_dir, c_pdf.filename)
                with open(c_path, "wb") as f:
                    shutil.copyfileobj(c_pdf.file, f)
                consent_map[c_pdf.filename] = c_path

            yield json.dumps({"type": "status", "message": "Opening Site Plan..."}) + "\n"
            locator = SitePlanLocator(site_plan_path)
            
            output_zip_path = os.path.join(temp_dir, f"results_{file_id}.zip")
            output_excel_buffer = BytesIO()
            
            total = len(results_list)
            processed = 0
            
            with zipfile.ZipFile(output_zip_path, "w", zipfile.ZIP_DEFLATED) as zip_file:
                for row in results_list:
                    processed += 1
                    name = row.get("Signed by") or row.get("proprietor_name")
                    title = row.get("Plot No") or row.get("title_number")
                    
                    yield json.dumps({
                        "type": "progress", 
                        "current": processed, 
                        "total": total, 
                        "message": f"Processing {name or title or 'page'}..."
                    }) + "\n"
                    
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
                    
                    await asyncio.sleep(0.01)

                yield json.dumps({"type": "status", "message": "Updating Excel List..."}) + "\n"
                with open(excel_path, "rb") as f:
                    ExcelWriter.append_data(f, results_list, output_excel_buffer)
                
                zip_file.writestr("Wayleave_Master_List_Updated.xlsx", output_excel_buffer.getvalue())

            locator.close()
            
            # Register for download
            DOWNLOAD_REGISTRY[file_id] = {
                "path": output_zip_path,
                "dir": temp_dir
            }
            
            yield json.dumps({
                "type": "complete", 
                "download_url": f"/download/{file_id}",
                "filename": "Wayleave_Automation_Results.zip"
            }) + "\n"

        except Exception as e:
            import traceback
            error_details = traceback.format_exc()
            print(f"Finalization Error: {e}\n{error_details}")
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"
            if os.path.exists(temp_dir):
                shutil.rmtree(temp_dir)

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")

@app.get("/download/{file_id}")
async def download_file(file_id: str, background_tasks: BackgroundTasks):
    if file_id not in DOWNLOAD_REGISTRY:
        raise HTTPException(status_code=404, detail="File not found or expired")
    
    item = DOWNLOAD_REGISTRY[file_id]
    path = item["path"]
    temp_dir = item["dir"]
    
    # Schedule cleanup after download
    def cleanup():
        import time
        time.sleep(10) # Wait for download to start/finish
        if os.path.exists(temp_dir):
            try:
                shutil.rmtree(temp_dir)
            except Exception: pass
        if file_id in DOWNLOAD_REGISTRY:
            del DOWNLOAD_REGISTRY[file_id]

    background_tasks.add_task(cleanup)
    
    return FileResponse(
        path,
        media_type="application/zip",
        filename="Wayleave_Automation_Results.zip"
    )

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
