# Wayleave Automation Project

This tool automates the process of extracting details from Wayleave Consent Forms and matching them with a Site Plan to generate professional snippets.

## Project Structure

*   **/data**: Place your input PDFs here.
    *   `test1.pdf`: The consent form(s).
    *   `KAPKOROS_merged.pdf`: The master site plan.
*   **/src**: Contains the core logic (`workflow_lib.py`) and automation engine.
*   **/output**: Where the processed PDFs are saved.
*   **/debug**: Contains logs and development scripts.
*   `run.py`: The main entry point (runner).

## How to Run

1.  Ensure your input files are in the `data` folder.
2.  Open a terminal in the project root directory (`f:\REREC\KAPKOROS`).
3.  Run the following command:

```powershell
python run.py
```

## How it Works
1.  **AI Extraction**: Gemini analyzes the handwritten consent forms to find the Name, Plot Number, and Snippet Location.
2.  **Smart Matching**: The engine uses a "Fuzzy 2-Token" logic to find the proprietor on the site plan with high precision, even if there are misspellings.
3.  **Aesthetic Snippet**: A rectangular crop is generated, centered on the proprietor's name, and overlayed onto the original form with 5% padding for a clean look.
