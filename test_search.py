import fitz
import traceback
import sys

def main():
    print("Opening PDF...")
    try:
        doc = fitz.open("SINENDET VILLAGE_merged_removed.pdf")
        print("Opened. Pages:", len(doc))
        for i, page in enumerate(doc):
            try:
                hits = page.search_for("Sinendet")
                print(f"Page {i} hits:", len(hits))
                
                # Test the get_text("dict") since that's what Plot Number logic uses
                blocks = page.get_text("dict")["blocks"]
                print(f"Page {i} blocks:", len(blocks))
            except Exception as e:
                print(f"Exception on page {i}:", e)
        doc.close()
    except Exception as e:
        traceback.print_exc()

if __name__ == "__main__":
    main()
