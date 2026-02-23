
import os
import streamlit as st
import tempfile
import zipfile
from io import BytesIO
from workflow_lib import ConsentExtractor, SitePlanLocator, PDFProcessor

# --- UI CONFIGURATION ---
st.set_page_config(
    page_title="REREC Wayleave Automation",
    page_icon="⚡",
    layout="wide"
)

# Custom CSS for a more premium look
st.markdown("""
    <style>
    .main {
        background-color: #f8f9fa;
    }
    .stButton>button {
        width: 100%;
        border-radius: 5px;
        height: 3em;
        background-color: #007bff;
        color: white;
    }
    .status-box {
        padding: 1rem;
        border-radius: 0.5rem;
        background-color: white;
        border: 1px solid #dee2e6;
        margin-bottom: 1rem;
    }
    </style>
""", unsafe_allow_html=True)

st.title("⚡ REREC Wayleave Automation")
st.markdown("Automate the extraction and site plan placement for Wayleave Consent Forms.")

# --- SIDEBAR: MASTER SITE PLAN ---
st.sidebar.header("📁 Step 1: Site Plan")
site_plan_file = st.sidebar.file_uploader("Upload Master Site Plan (PDF)", type=["pdf"])

if site_plan_file:
    # Use session_state to cache the locator instance (indexing is expensive)
    if 'locator' not in st.session_state or st.session_state.get('site_plan_name') != site_plan_file.name:
        with st.sidebar.status("Indexing Site Plan...") as s:
            t_site_plan = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
            t_site_plan.write(site_plan_file.read())
            t_site_plan.close()
            
            st.session_state.locator = SitePlanLocator(t_site_plan.name)
            st.session_state.site_plan_name = site_plan_file.name
            s.update(label="Site Plan Indexed!", state="complete")
            # Note: We don't unlink here because SitePlanLocator keeps the file open.
            # It will be cleaned up by the OS temp cleaner eventually.
    st.sidebar.success(f"Loaded: {site_plan_file.name}")
else:
    st.sidebar.info("Please upload the Master Site Plan to begin.")

# --- MAIN PANEL: CONSENT FORMS ---
st.header("📄 Step 2: Consent Forms")
consent_files = st.file_uploader("Upload Wayleave Consent Forms (PDF or Images)", type=["pdf", "png", "jpg", "jpeg"], accept_multiple_files=True)

if consent_files and 'locator' in st.session_state:
    if st.button("🚀 Process All Documents"):
        output_zip_buffer = BytesIO()
        processed_files = []
        
        # Calculate total pages for better progress tracking
        import fitz
        total_pages = 0
        for c_file in consent_files:
            if c_file.type == "application/pdf":
                try:
                    c_file.seek(0)
                    pdf_data = c_file.read()
                    with fitz.open(stream=pdf_data, filetype="pdf") as doc:
                        total_pages += len(doc)
                    c_file.seek(0)
                except:
                    total_pages += 1
            else:
                total_pages += 1

        from concurrent.futures import ThreadPoolExecutor, as_completed
        
        with zipfile.ZipFile(output_zip_buffer, "a", zipfile.ZIP_DEFLATED, False) as zip_file:
            progress_bar = st.progress(0.0)
            status_text = st.empty()
            log_container = st.empty()
            logs = []
            
            # --- TASK DISPATCHER ---
            # We will create a list of all pages to process across all files
            tasks = []
            temp_files = [] # To keep track of temp files for cleanup
            
            for c_file in consent_files:
                # Save to temp
                t_consent = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
                t_consent.write(c_file.read())
                t_consent.close()
                temp_files.append((c_file.name, t_consent.name))
                
                # Determine number of pages
                try:
                    with fitz.open(t_consent.name) as doc:
                        for p_idx in range(len(doc)):
                            tasks.append({
                                "file_name": c_file.name,
                                "temp_path": t_consent.name,
                                "page_num": p_idx
                            })
                except:
                    # Fallback for non-PDF or corrupt
                    tasks.append({
                        "file_name": c_file.name,
                        "temp_path": t_consent.name,
                        "page_num": 0
                    })

            total_tasks = len(tasks)
            status_text.text(f"Starting parallel processing of {total_tasks} pages...")
            
            extractor = ConsentExtractor()
            pages_completed = 0
            
            # Helper function for worker
            def process_worker(task):
                try:
                    data = extractor.process_page(task["temp_path"], task["page_num"])
                    return {"task": task, "data": data, "error": None}
                except Exception as e:
                    return {"task": task, "data": None, "error": str(e)}

            # --- EXECUTION ---
            with ThreadPoolExecutor(max_workers=5) as executor: # Process 5 pages at a time
                future_to_task = {executor.submit(process_worker, t): t for t in tasks}
                
                for future in as_completed(future_to_task):
                    res = future.result()
                    task = res["task"]
                    data = res["data"]
                    error = res["error"]
                    
                    pages_completed += 1
                    progress_bar.progress(pages_completed / total_tasks)
                    
                    f_name = task["file_name"]
                    p_num = task["page_num"]
                    
                    if error:
                        logs.append(f"🔥 {f_name} (P{p_num+1}): {error}")
                    elif not data:
                        logs.append(f"❌ {f_name} (P{p_num+1}): Gemini Extraction Failed")
                    else:
                        name = data.get("proprietor_name")
                        title = data.get("title_number")
                        box = data.get("sketch_box_1000")
                        page_rotation = data.get("rotation", 0)

                        if not name or not box:
                            logs.append(f"⚠️ {f_name} (P{p_num+1}): Missing Proprietor Name or Sketch Box")
                        else:
                            # Search in Site Plan
                            result = st.session_state.locator.search(name, title)
                            
                            if not result:
                                logs.append(f"🔍 {f_name} (P{p_num+1}): No match found for '{name}'")
                            else:
                                # Process Match & Overlay
                                with tempfile.TemporaryDirectory() as temp_dir:
                                    snippet_path = os.path.join(temp_dir, "snippet.png")
                                    output_pdf_path = os.path.join(temp_dir, "processed.pdf")
                                    
                                    box_w = box[3] - box[1]
                                    box_h = box[2] - box[0]
                                    aspect_ratio = box_w / box_h if box_h != 0 else 1.0
                                    
                                    st.session_state.locator.get_snippet(result, snippet_path, aspect_ratio=aspect_ratio)
                                    PDFProcessor.overlay_snippet(task["temp_path"], snippet_path, box, output_pdf_path, page_index=p_num, rotation=page_rotation)
                                    
                                    # Add to ZIP
                                    safe_title = str(title).replace('/', '_').replace('\\', '_')
                                    zip_name = f"{os.path.splitext(f_name)[0]}_P{p_num+1}_{safe_title}.pdf"
                                    with open(output_pdf_path, "rb") as f:
                                        zip_file.writestr(zip_name, f.read())
                                    
                                    logs.append(f"✅ {f_name} (P{p_num+1}): Matched {name}")

                    # Update Log UI
                    with log_container.container():
                        st.markdown("### Process Log")
                        for log in logs[-5:]:
                            st.write(log)

            # Cleanup Temp Files
            for _, path in temp_files:
                if os.path.exists(path):
                    try:
                        os.unlink(path)
                    except:
                        pass

            status_text.text("Done!")

            progress_bar.progress(1.0)
            status_text.text("Done!")

        # Final Download
        from datetime import datetime
        project_short_name = os.path.splitext(st.session_state.site_plan_name)[0]
        timestamp = datetime.now().strftime("%Y%m%d_%H%M")
        zip_filename = f"Wayleave_Results_{project_short_name}_{timestamp}.zip"

        st.success(f"Processing Complete! Successfully matched {len([l for l in logs if '✅' in l])} items.")
        st.download_button(
            label="💾 Download All Processed PDFs (ZIP)",
            data=output_zip_buffer.getvalue(),
            file_name=zip_filename,
            mime="application/zip"
        )
elif not site_plan_file:
    st.warning("Please upload a Master Site Plan in the sidebar before processing consent forms.")
else:
    st.info("Upload one or more Wayleave Consent Forms to begin.")

# --- FOOTER ---
st.divider()
st.caption("Powered by REREC Engineering & Gemini Vision AI")
