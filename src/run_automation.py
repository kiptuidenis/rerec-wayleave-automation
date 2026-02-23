
import os
import shutil
from workflow_lib import ConsentExtractor, SitePlanLocator, PDFProcessor

# PATHS
INPUT_DIR = "data"
OUTPUT_DIR = "output"
LOG_FILE = "debug/manual_review_required.txt"

SOURCE_PDF = os.path.join(INPUT_DIR, "test1.pdf")
SITE_PLAN_PDF = os.path.join(INPUT_DIR, "KAPKOROS_merged.pdf")

def main():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        
    # Initialize Agents
    print("Initializing Gemini Extractor...")
    extractor = ConsentExtractor() # Uses default defined in lib
    
    print("Initializing Site Plan Locator...")
    locator = SitePlanLocator(SITE_PLAN_PDF)
    
    # Process
    print(f"Processing {SOURCE_PDF}...")
    
    # 1. Extract Details (Iterate Pages)
    processed_count = 0
    extractor_gen = extractor.extract_details(SOURCE_PDF)
    
    # We need to act on the same doc or copies? 
    # PDFProcessor overlay works on file path. 
    # If we have multiple pages, we should update the same file progressively OR save separate pages.
    # Saving separate pages is safer for now: "Page1_Processed.pdf", "Page2_Processed.pdf".
    
    for page_idx, data in extractor_gen:
        if not data:
            log_failure(f"{SOURCE_PDF} (Page {page_idx+1})", "Gemini Extraction Failed")
            continue

        name = data.get("proprietor_name")
        title = data.get("title_number")
        box = data.get("sketch_box_1000")
        
        print(f"\n--- Page {page_idx+1}: {name} (Plot {title}) ---")
        
        if not name or not box:
            log_failure(f"{SOURCE_PDF} (Page {page_idx+1})", "Missing Name or Sketch Box coordinates")
            continue

        # 2. Locate in Site Plan
        print("Searching in Site Plan (Iterating Candidates)...")
        result = locator.search(name, title)
        
        if not result:
            log_failure(f"{SOURCE_PDF} (Page {page_idx+1})", f"Could not find {name} or confirm Plot '{title}' in Site Plan")
            continue
            
        print(f"Found Match via {result['method']} on Page {result['page'] + 1}")

        # 3. Generate Snippet
        # Calculate aspect ratio of the target box (Width / Height)
        # box = [ymin, xmin, ymax, xmax]
        box_w = box[3] - box[1]
        box_h = box[2] - box[0]
        aspect_ratio = box_w / box_h if box_h != 0 else 1.0

        snippet_path = os.path.join(OUTPUT_DIR, f"snippet_p{page_idx}.png")
        locator.get_snippet(result, snippet_path, aspect_ratio=aspect_ratio)
        
        # 4. Create Page-Specific PDF
        output_pdf_name = f"Page{page_idx+1}_{title.replace('/', '_')}_Processed.pdf"
        output_pdf = os.path.join(OUTPUT_DIR, output_pdf_name)
        
        # Pass rotation
        page_rotation = data.get("rotation", 0)
        
        PDFProcessor.overlay_snippet(SOURCE_PDF, snippet_path, box, output_pdf, page_index=page_idx, rotation=page_rotation)
        print(f"Success! Saved to {output_pdf}")
        processed_count += 1
        
        # Cleanup
        if os.path.exists(snippet_path):
            os.remove(snippet_path)

    print(f"\nDone. Processed {processed_count} pages.")

def log_failure(filename, reason):
    print(f"[SKIP] {filename}: {reason}")
    with open(LOG_FILE, "a") as f:
        f.write(f"{filename}: {reason}\n")

if __name__ == "__main__":
    main()
