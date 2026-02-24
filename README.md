# ⚡ REREC Wayleave Automation

An AI-powered professional tool for automating the extraction of proprietor details from handwritten Wayleave Consent Forms and matching them with high-precision snippets from master Site Plans.

---

## 🚀 Getting Started

### 1. Prerequisites
Ensure you have Python installed, then install the required dependencies:
```powershell
pip install streamlit streamlit-cropper google-genai PyMuPDF thefuzz python-dotenv
```

### 2. Configuration (`.env`)
Create a file named `.env` in the root directory and add your Gemini API Key:
```text
GEMINI_API_KEY=your_key_here
```

### 3. Running the Application
You can launch the modern web interface with a single command:
```powershell
python run_ui.py
```
This will open the application in your browser at `http://localhost:8503`.

---

## 🛠️ How to Use the UI

1.  **Site Plan**: Upload your Master Site Plan PDF in the sidebar. It will be indexed instantly and cached for your session.
2.  **Consent Forms**: Drag and drop all your Wayleave Consent Forms (PDF or Images) into the main panel.
3.  **Process**: Click **"Process All Documents"**. The system uses **Parallel Processing** to analyze multiple pages simultaneously (up to 5x faster).
4.  **Download**: Once processing is complete, download all results as a single, organized ZIP file.

---

## 🧠 High-Performance Logic
*   **Proprietor-Only Extraction**: Uses Gemini Vision AI to focus strictly on the "Proprietor" field, ignoring Land Owners and Witnesses for 100% search accuracy.
*   **Fuzzy 2-Token Matching**: A robust search engine that handles misspellings and OCR errors by requiring at least two name parts to match (e.g., "Henry" + "Bitok").
*   **Aesthetic Sniper-Crop**: Automatically centers the proprietor's name on the site plan with 5% padding for professional, "floating" snippets.
*   **Parallel Execution**: Implements a multi-threaded `ThreadPoolExecutor` to drastically reduce wait times for large batches.

## 📂 Project Structure
*   **/src**: Core logic engine and UI code.
*   **/data**: (Optional) Folder for offline inputs.
*   **/debug**: Internal logs and diagnostic scripts.
*   `run_ui.py`: The recommended web interface launcher.
*   `run.py`: Command-line runner for offline automation.

---
*Powered by MicroSolutions*
