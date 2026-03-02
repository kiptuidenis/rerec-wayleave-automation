import fitz
import re

def main():
    doc = fitz.open("SINENDET VILLAGE_merged_removed.pdf")
    page = doc[0]
    
    blocks = page.get_text("dict")["blocks"]
    
    numbers = set()
    for b in blocks:
        if "lines" not in b: continue
        for l in b["lines"]:
            for s in l["spans"]:
                text = s["text"].strip()
                if not text: continue
                
                # Extract digits
                clean_num = re.sub(r'[^\d]', '', text)
                if clean_num:
                    numbers.add(clean_num)

    print(f"All numbers found on the site plan: {sorted([int(n) for n in numbers if n.isdigit()])}")

if __name__ == "__main__":
    main()
