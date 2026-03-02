import os
import sys
# Add current directory to path to import server
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import fitz
fitz.TOOLS.mupdf_display_errors(False)

from server.workflow_lib import ConsentExtractor, SitePlanLocator

def main():
    print("Initializing...")
    extractor = ConsentExtractor()
    doc = fitz.open("Consent_forms_3.pdf")
    print("Opened Consent_forms_3.pdf")
    
    # Process just the first 2 pages
    extracted_data = []
    for i in range(2):
        print(f"Extracting page {i}...")
        data = extractor.process_page(doc, i)
        print("Data:", data)
        if data and data.get("is_wayleave_consent_form"):
            extracted_data.append(data)
            
    doc.close()
    
    locator = SitePlanLocator("SINENDET VILLAGE_merged_removed.pdf")
    
    for data in extracted_data:
        name = data.get("Signed by") or data.get("proprietor_name")
        title = data.get("Plot No") or data.get("title_number")
        print("\n=== Searching ===")
        print(f"Name: {name}, Title: {title}")
        match = locator.search(name, title)
        print("Match Result:", match)

if __name__ == "__main__":
    main()
