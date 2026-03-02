import fitz

def main():
    doc = fitz.open("SINENDET VILLAGE_merged_removed.pdf")
    page = doc[0]
    
    blocks = page.get_text("dict")["blocks"]
    
    print(f"Total blocks: {len(blocks)}")
    
    for b in blocks:
        if "lines" not in b: continue
        for l in b["lines"]:
            for s in l["spans"]:
                text = s["text"].strip()
                if not text: continue
                
                # Check for our target phrases (case insensitive)
                lower_text = text.lower()
                if any(x in lower_text for x in ["316", "317", "elizabeth", "manum", "rodgers", "31", "16", "17", "jep"]):
                    print(f"Found match: '{text}' at {s['bbox']}")
                    print(f"  Font: {s['font']}, Size: {s['size']}, Color: {s['color']}")

if __name__ == "__main__":
    main()
