import os
import streamlit as st
import tempfile
import zipfile
import fitz
import pandas as pd
from io import BytesIO
from workflow_lib import ConsentExtractor, SitePlanLocator, PDFProcessor, ExcelWriter

# --- UI CONFIGURATION ---
st.set_page_config(
    page_title="REREC Wayleave Unified System",
    page_icon="⚡",
    layout="wide"
)

st.markdown("""
    <style>
    .main { background-color: #f8f9fa; }
    .stButton>button { width: 100%; border-radius: 5px; height: 3em; background-color: #007bff; color: white; }
    .step-header { color: #007bff; font-weight: bold; margin-top: 2rem; border-bottom: 2px solid #007bff; padding-bottom: 0.5rem; }
    </style>
""", unsafe_allow_html=True)

st.title("⚡ REREC Wayleave Unified System")
st.markdown("Extract data for Excel master lists and generate site plan snippets in one workflow.")

# --- API KEY VALIDATION ---
from workflow_lib import API_KEY as WORKFLOW_API_KEY
if not WORKFLOW_API_KEY or WORKFLOW_API_KEY == "MISSING_KEY":
    st.error("### ⚠️ Gemini API Key Missing")
    st.markdown("""
    The `GEMINI_API_KEY` was not found in your environment or `.env` file. 
    1. Create a file named `.env` in the project root.
    2. Add this line: `GEMINI_API_KEY=your_key_here`
    3. Restart the application.
    """)
    st.stop()

# --- SIDEBAR: MASTER FILES ---
st.sidebar.header("📁 Master Files")
site_plan_file = st.sidebar.file_uploader("Upload Master Site Plan (PDF)", type=["pdf"])
excel_template = st.sidebar.file_uploader("Upload Excel Master List (XLSX)", type=["xlsx"])

if site_plan_file:
    if 'locator' not in st.session_state or st.session_state.get('site_plan_name') != site_plan_file.name:
        with st.sidebar.status("Indexing Site Plan...") as s:
            try:
                t_site_plan = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
                t_site_plan.write(site_plan_file.read())
                t_site_plan.close()
                st.session_state.locator = SitePlanLocator(t_site_plan.name)
                st.session_state.site_plan_name = site_plan_file.name
                s.update(label="Site Plan Indexed!", state="complete")
            except Exception as e:
                st.sidebar.error(f"Failed to read Site Plan: {e}")
                s.update(label="Indexing Failed", state="error")
    st.sidebar.success(f"Site Plan: {site_plan_file.name}")

if excel_template:
    st.sidebar.success(f"Excel Template: {excel_template.name}")

# --- INITIALIZATION ---
if "extraction_results" not in st.session_state:
    st.session_state.extraction_results = []
if "image_previews" not in st.session_state:
    st.session_state.image_previews = {}
if "temp_paths" not in st.session_state:
    st.session_state.temp_paths = {}
if "final_zip" not in st.session_state:
    st.session_state.final_zip = None
if "final_xlsx" not in st.session_state:
    st.session_state.final_xlsx = None
if "final_logs" not in st.session_state:
    st.session_state.final_logs = []

# --- STEP 1: UPLOAD & EXTRACT ---
st.markdown("<div class='step-header'>Step 1: Upload & Parallel Extraction</div>", unsafe_allow_html=True)
consent_files = st.file_uploader("Upload Scanned Wayleave Consent Forms (PDF)", type=["pdf"], accept_multiple_files=True)

if consent_files and site_plan_file and excel_template:
    if st.button("🔍 Run AI Extraction Phase"):
        st.session_state.extraction_results = []
        st.session_state.image_previews = {}
        st.session_state.final_zip = None
        st.session_state.final_xlsx = None
        
        tasks = []
        for c_file in consent_files:
            t_consent = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
            t_consent.write(c_file.read())
            t_consent.close()
            st.session_state.temp_paths[c_file.name] = t_consent.name
            
            with fitz.open(t_consent.name) as doc:
                for p_idx in range(len(doc)):
                    tasks.append({"file_name": c_file.name, "temp_path": t_consent.name, "page_num": p_idx})

        from concurrent.futures import ThreadPoolExecutor, as_completed
        progress_bar = st.progress(0.0)
        status_text = st.empty()
        
        extractor = ConsentExtractor()
        extracted_data = []

        def process_worker(task):
            try:
                data = extractor.process_page(task["temp_path"], task["page_num"])
                # Generate image preview for the viewer
                img_bytes = None
                if data:
                    with fitz.open(task["temp_path"]) as doc:
                        page = doc[task["page_num"]]
                        pix = page.get_pixmap(dpi=150)
                        img_bytes = pix.tobytes("png")
                return {"task": task, "data": data, "preview": img_bytes, "error": None}
            except Exception as e:
                return {"task": task, "data": None, "preview": None, "error": str(e)}

        with ThreadPoolExecutor(max_workers=5) as executor:
            future_to_task = {executor.submit(process_worker, t): t for t in tasks}
            for i, future in enumerate(as_completed(future_to_task)):
                res = future.result()
                if res["data"]:
                    # Unique ID for tracking
                    row_id = f"{res['task']['file_name']}_p{res['task']['page_num']}"
                    data_row = res["data"]
                    data_row["_id"] = row_id
                    data_row["_file_name"] = res["task"]["file_name"]
                    data_row["_page_num"] = res["task"]["page_num"]
                    extracted_data.append(data_row)
                    st.session_state.image_previews[row_id] = res["preview"]
                elif res["error"]:
                    st.error(f"Error on {res['task']['file_name']} (Page {res['task']['page_num']+1}): {res['error']}")
                
                progress_bar.progress((i + 1) / len(tasks))
                status_text.text(f"Processed {i+1}/{len(tasks)} pages...")

        st.session_state.extraction_results = extracted_data
        st.success(f"Extraction complete! {len(extracted_data)} documents ready for review.")

# --- STEP 2: REVIEW & EDIT ---
if st.session_state.extraction_results:
    st.markdown("<div class='step-header'>Step 2: Review & Edit Data</div>", unsafe_allow_html=True)
    
    col_table, col_viewer = st.columns([2, 1])
    
    with col_table:
        # Display only editable fields in data editor
        editable_cols = ["Project Name", "Owned by", "Signed by", "Relationship", "ID No", "Phone No", "Plot No", "Consent Signed"]
        df_display = pd.DataFrame(st.session_state.extraction_results)
        
        edited_df = st.data_editor(
            df_display,
            column_order=editable_cols,
            use_container_width=True,
            num_rows="dynamic",
            key="data_editor_key"
        )
        # Reflect changes back to session state
        st.session_state.extraction_results = edited_df.to_dict('records')

    with col_viewer:
        st.markdown("#### Image Viewer")
        if not df_display.empty:
            view_id = st.selectbox("Select document to view", options=df_display["_id"].tolist())
            if view_id in st.session_state.image_previews:
                st.image(st.session_state.image_previews[view_id], use_container_width=True)

# --- STEP 3: FINAL PROCESSING ---
st.markdown("<div class='step-header'>Step 3: Finalize Visuals & Excel Master</div>", unsafe_allow_html=True)
if st.button("🚀 Generate Snippets & Update Excel"):
    output_zip_buffer = BytesIO()
    output_excel_buffer = BytesIO()
    st.session_state.final_logs = []
    
    success_count = 0
    match_count = 0
    fail_count = 0
    
    try:
        with zipfile.ZipFile(output_zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            progress_bar = st.progress(0.0)
            total_items = len(st.session_state.extraction_results)
            
            for i, row in enumerate(st.session_state.extraction_results):
                try:
                    name = row.get("Signed by") or row.get("proprietor_name")
                    title = row.get("Plot No") or row.get("title_number")
                    box = row.get("sketch_box_1000")
                    f_name = row.get("_file_name")
                    p_num = row.get("_page_num")
                    temp_path = st.session_state.temp_paths.get(f_name)

                    if name and box and temp_path:
                        match = st.session_state.locator.search(name, title)
                        if match:
                            with tempfile.TemporaryDirectory() as temp_dir:
                                snip_path = os.path.join(temp_dir, "snippet.png")
                                out_pdf_path = os.path.join(temp_dir, "processed.pdf")
                                
                                box_w = box[3] - box[1]
                                box_h = box[2] - box[0]
                                aspect_ratio = box_w / box_h if box_h != 0 else 1.0
                                
                                st.session_state.locator.get_snippet(match, snip_path, aspect_ratio=aspect_ratio)
                                success = PDFProcessor.overlay_snippet(temp_path, snip_path, box, out_pdf_path, page_index=p_num, rotation=row.get("rotation", 0))
                                
                                if success and os.path.exists(out_pdf_path):
                                    safe_title = str(title).replace('/', '_').replace('\\', '_')
                                    zip_name = f"{os.path.splitext(f_name)[0]}_P{p_num+1}_{safe_title}.pdf"
                                    with open(out_pdf_path, "rb") as f:
                                        zip_file.writestr(zip_name, f.read())
                                    st.session_state.final_logs.append(f"✅ {f_name} Matched: {name}")
                                    match_count += 1
                                else:
                                    st.session_state.final_logs.append(f"❌ {f_name} (P{p_num+1}): Overlay Failed")
                                    fail_count += 1
                        else:
                            st.session_state.final_logs.append(f"🔍 {f_name} (P{p_num+1}): No Match for '{name}'")
                            fail_count += 1
                    else:
                        st.session_state.final_logs.append(f"⚠️ {f_name} (P{p_num+1}): Incomplete extraction data")
                        fail_count += 1
                    
                    success_count += 1
                except Exception as inner_e:
                    st.session_state.final_logs.append(f"🔥 Error processing row {i+1}: {inner_e}")
                    fail_count += 1
                
                progress_bar.progress((i + 1) / total_items)

            # Update Excel Template
            try:
                ExcelWriter.append_data(excel_template, st.session_state.extraction_results, output_excel_buffer)
            except PermissionError:
                st.error("### ❌ Excel Template Locked\nPlease close the Excel master list file and try again.")
                st.stop()
            except Exception as e:
                st.error(f"Failed to update Excel: {e}")
                st.stop()
            
        # --- STORAGE ---
        st.session_state.final_zip = output_zip_buffer.getvalue()
        st.session_state.final_xlsx = output_excel_buffer.getvalue()
        
        # Summary Metrics
        zip_size_kb = len(st.session_state.final_zip) / 1024
        st.session_state.final_logs.append(f"📊 Summary: {success_count} processed, {match_count} matched, {fail_count} skipped/failed.")
        st.session_state.final_logs.append(f"📦 ZIP Finalized: {zip_size_kb:.1f} KB")
        
        st.rerun()
    except Exception as e:
        st.error(f"A critical error occurred during finalization: {e}")

# Display Results if they exist in session state
if st.session_state.final_zip and st.session_state.final_xlsx:
    st.success(f"Final Processing Complete!")
    
    # Dashboard summary
    m1, m2, m3 = st.columns(3)
    m1.metric("Documents Processed", len(st.session_state.extraction_results))
    m2.metric("Successful Matches", len([l for l in st.session_state.final_logs if "✅" in l]))
    m3.metric("Fails / No Matches", len([l for l in st.session_state.final_logs if "🔍" in l or "❌" in l or "🔥" in l or "⚠️" in l]))
    
    down_col1, down_col2 = st.columns(2)
    
    from datetime import datetime
    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    
    with down_col1:
        st.download_button(
            label="💾 Download Processed PDFs (ZIP)",
            data=st.session_state.final_zip,
            file_name=f"Wayleave_Visuals_{timestamp}.zip",
            mime="application/zip"
        )
    with down_col2:
        st.download_button(
            label="📊 Download Updated Excel Master",
            data=st.session_state.final_xlsx,
            file_name=f"Wayleave_Master_List_{timestamp}.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
    
    if st.session_state.final_logs:
        st.markdown("### Process Log")
        for log in st.session_state.final_logs:
            st.write(log)

elif not site_plan_file or not excel_template:
    st.info("Please upload both the Master Site Plan and Excel Template to begin.")

# Footer with developer credit
st.divider()
st.caption("Powered by MicroSolutions")
