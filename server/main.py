import os
import tempfile
import zipfile
import shutil
import json
import fitz  # PyMuPDF
from io import BytesIO
from typing import List
from collections import defaultdict
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from workflow_lib import ConsentExtractor, SitePlanLocator, PDFProcessor, ExcelWriter
# Add current directory to sys.path to ensure workflow_lib is found if run from elsewhere
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# CRITICAL FIX: The user's C: drive has 0 bytes free. 
# Force all temporary spooling (FastAPI uploads, Python tmp files) to use the F: drive.
temp_dir_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".tmp")
os.makedirs(temp_dir_path, exist_ok=True)
import tempfile
tempfile.tempdir = temp_dir_path

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

from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi import Request

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    import traceback
    print(f"Validation Error: {exc.errors()}")
    print(f"Body: {exc.body}")
    return JSONResponse(
        status_code=400,
        content={"detail": exc.errors(), "body": str(exc.body)},
    )

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Wayleave Automation API is running"}

@app.post("/extract")
async def extract_documents(request: Request):
    from fastapi.responses import StreamingResponse
    import asyncio
    
    try:
        form = await request.form()
        files = form.getlist("files")
        processed_pages = form.get("processed_pages")
    except Exception as e:
        print(f"Error parsing form data: {e}")
        return JSONResponse(status_code=400, content={"detail": f"Form parse error: {str(e)}"})
    
    if not files:
        return JSONResponse(status_code=400, content={"detail": "No files provided"})
        
    # Parse processed pages map: {"filename.pdf": [0, 1, 2], ...}
    processed_map = {}
    if processed_pages:
        try:
            processed_map = json.loads(processed_pages)
            # Convert list of pages to set for faster lookup
            for k, v in processed_map.items():
                processed_map[k] = set(v)
        except Exception as e:
            print(f"Warning: Failed to parse processed_pages: {e}")

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
                
                # Get the set of already processed pages for this specific file
                skip_pages = processed_map.get(item["name"], set())
                
                # extractor.extract_details is now yielding (page_num, event_dict)
                for page_num, event in extractor.extract_details(item["path"], processed_pages=skip_pages):
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

@app.post("/download-excel")
async def download_excel(
    extraction_results_file: UploadFile = File(...),
    excel_template: UploadFile = File(...)
):
    try:
        content = await extraction_results_file.read()
        results_list = json.loads(content.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid extraction_results JSON")
    
    temp_dir = tempfile.mkdtemp()
    try:
        excel_path = os.path.join(temp_dir, "template.xlsx")
        with open(excel_path, "wb") as f:
            shutil.copyfileobj(excel_template.file, f)
            
        output_excel_buffer = BytesIO()
        ExcelWriter.append_data(excel_path, results_list, output_excel_buffer)
        
        return Response(
            content=output_excel_buffer.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": "attachment; filename=Wayleave_Master_List_Edited.xlsx"}
        )
    except Exception as e:
        print(f"Excel Export Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)

@app.post("/finalize")
async def finalize_project(
    background_tasks: BackgroundTasks,
    extraction_results_file: UploadFile = File(...),
    site_plan: UploadFile = File(...),
    excel_template: UploadFile = File(...),
    consent_pdfs: List[UploadFile] = File(...)
):
    from fastapi.responses import StreamingResponse
    import asyncio
    import uuid
    
    try:
        content = await extraction_results_file.read()
        results_list = json.loads(content.decode("utf-8"))
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
            
            # Grouping records by source file to maintain structure
            file_groups = defaultdict(list)
            for row in results_list:
                f_name = row.get("_file_name")
                if f_name:
                    file_groups[f_name].append(row)

            total_files = len(file_groups)
            processed_files = 0
            
            with zipfile.ZipFile(output_zip_path, "w", zipfile.ZIP_DEFLATED) as zip_file:
                for f_name, rows in file_groups.items():
                    processed_files += 1
                    temp_source_path = consent_map.get(f_name)
                    if not temp_source_path: continue

                    yield json.dumps({
                        "type": "progress", 
                        "current": processed_files, 
                        "total": total_files, 
                        "message": f"Annotating {f_name}..."
                    }) + "\n"

                    overlay_items = []
                    for row in rows:
                        name = row.get("Signed by") or row.get("proprietor_name")
                        title = row.get("Plot No") or row.get("title_number")
                        box = row.get("sketch_box_1000")
                        p_num = row.get("_page_num")
                        
                        if name and box:
                            match = locator.search(name, title)
                            if match:
                                snip_path = os.path.join(temp_dir, f"snip_{row['_id']}.png")
                                box_w = box[3] - box[1]
                                box_h = box[2] - box[0]
                                aspect_ratio = box_w / box_h if box_h != 0 else 1.0
                                
                                locator.get_snippet(match, snip_path, aspect_ratio=aspect_ratio)
                                overlay_items.append({
                                    "page_index": p_num,
                                    "snippet_path": snip_path,
                                    "box": box,
                                    "rotation": row.get("rotation", 0)
                                })
                    
                    if overlay_items:
                        out_filename = f"Annotated_{f_name}"
                        out_pdf_path = os.path.join(temp_dir, out_filename)
                        success = PDFProcessor.apply_batch_overlays(temp_source_path, overlay_items, out_pdf_path)
                        if success and os.path.exists(out_pdf_path):
                            zip_file.write(out_pdf_path, out_filename)
                        else:
                            zip_file.write(temp_source_path, f"Original_{f_name}")
                    else:
                        zip_file.write(temp_source_path, f"Original_{f_name}")

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
            
            # Ensure open documents are closed before cleaning up
            if 'locator' in locals() and hasattr(locator, 'close'):
                locator.close()
                
            if os.path.exists(temp_dir):
                for _ in range(3):
                    try:
                        shutil.rmtree(temp_dir)
                        break
                    except PermissionError:
                        await asyncio.sleep(0.5)
                    except Exception:
                        break

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
async def get_preview(request: Request):
    try:
        form = await request.form()
        file = form.get("file")
        page_num_str = form.get("page_num")
        page_num = int(page_num_str) if page_num_str else 0
    except Exception as e:
        return JSONResponse(status_code=400, content={"detail": f"Form parse error: {str(e)}"})
    
    if not file:
        return JSONResponse(status_code=400, content={"detail": "No file provided"})
        
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

@app.post("/analyze-site-plan")
async def analyze_site_plan(request: Request):
    """
    Validates if a site plan PDF has searchable text or if it is just a rasterized image/flattened drawing.
    """
    try:
        form = await request.form()
        file = form.get("file")
    except Exception as e:
        return JSONResponse(status_code=400, content={"detail": f"Form parse error: {str(e)}"})
    
    if not file:
        return JSONResponse(status_code=400, content={"detail": "No file provided"})
        
    try:
        suffix = os.path.splitext(file.filename)[1]
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp_path = tmp.name
            
        try:
            doc = fitz.open(tmp_path)
            # Sample up to first 3 pages
            extracted_text = ""
            for i in range(min(3, len(doc))):
                extracted_text += doc[i].get_text()
                if len(extracted_text) > 4000:  # Enough text to be confident it's searchable
                    break
            
            # Simple heuristic: Real site plans have thousands of characters of labels.
            # Raster images or un-embedded SHX fonts yield almost nothing on the text layer.
            text_len = len(extracted_text.strip())
            is_searchable = text_len >= 4000  # Threshold for warning
            
            return {
                "is_searchable": is_searchable, 
                "text_length": text_len,
                "message": "Unsearchable PDF detected. The system cannot locate names or plots automatically. Please re-export Site Plan with 'Searchable Text / TrueType Fonts' enabled." if not is_searchable else "OK"
            }
        finally:
            if 'doc' in locals() and hasattr(doc, 'close'):
                doc.close()
            if os.path.exists(tmp_path):
                try: os.remove(tmp_path)
                except Exception: pass
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": str(e)})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
