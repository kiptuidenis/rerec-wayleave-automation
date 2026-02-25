import os
import io
import json
import fitz  # PyMuPDF
from google import genai
from google.genai import types
from thefuzz import fuzz
from dotenv import load_dotenv
from openpyxl import load_workbook
from openpyxl.styles import Font, Border, Alignment
from copy import copy

# Load environment variables from .env file if it exists
load_dotenv()

# CONFIGURATION
API_KEY = os.getenv("GEMINI_API_KEY")

if not API_KEY:
    # Fallback to an empty string to avoid crashes, but warn the user
    print("WARNING: GEMINI_API_KEY not found in environment or .env file.")
    API_KEY = "MISSING_KEY"

MODEL_NAME = "gemini-3-flash-preview"

# Column mapping for Excel: col_index -> JSON key (None = special handling)
COL_MAP = {
    1: None,                  # S/NO (auto-increment)
    2: "Project Name",
    3: "Constituency",
    4: "County",
    5: None,                  # Region (empty)
    6: None,                  # Affected land (empty)
    7: "Plot No",
    8: "Owned by",
    9: "Signed by",
    10: "Relationship",
    11: "ID No",
    12: "Phone No",
    13: None,                 # Ownership Document (empty)
    14: "Consent Signed",
}

class ConsentExtractor:
    def __init__(self, model_name=MODEL_NAME):
        self.client = genai.Client(api_key=API_KEY)
        self.model_name = model_name

    def extract_details(self, pdf_path):
        """
        Extracts details from ALL pages of the PDF sequentially.
        Yields: (page_num, data_json) or (page_num, None) if failed.
        """
        doc = None
        try:
            doc = fitz.open(pdf_path)
            for page_num in range(len(doc)):
                print(f"  Analyzing Page {page_num + 1}...")
                data = self.process_page(doc, page_num)
                if data and data.get("is_wayleave_consent_form"):
                    yield page_num, data
                elif data:
                    print(f"    [Skipping Page {page_num+1}] Not a Wayleave Consent Form (ID/Deed/Map/etc.)")
        except Exception as e:
            print(f"[Extractor Error] {e}")
            return
        finally:
            if doc:
                doc.close()
                print(f"  Closed PDF handle for {pdf_path}")

    def process_page(self, doc, page_num):
        """
        Extracts details from a specific page.
        Returns: data_json or None if failed.
        """
        try:
            page = doc[page_num]
            pix = page.get_pixmap(dpi=150) # 150 DPI is enough for text reading
            img_data = pix.tobytes("png")
            
            prompt = """
            Determine if this image is a 'WAYLEAVE CONSENT FORM'. 
            Standard forms have 'WAYLEAVE CONSENT FORM' as a title and fields for Land owner, Plot No, etc. 
            Scanned IDs, Maps, Title Deeds, or other documents are NOT consent forms.

            Extract the following from this image.
            Return ONLY valid JSON -- no markdown, no explanation.

            {
              "is_wayleave_consent_form": true or false,
              "Project Name": "Name of project/village",
              "Constituency": "Constituency name",
              "County": "County name",
              "Plot No": "Title/Plot number",
              "Owned by": "Full name of the land owner listed at the top",
              "Signed by": "Full name of the person who signed as Proprietor/Occupier (NOT witness)",
              "Relationship": "Relationship of signer to owner (e.g. SELF, WIFE, SON, HUSBAND)",
              "ID No": "ID number of the signer",
              "Phone No": "Phone number of the signer",
              "Consent Signed": "YES or NO",
              "proprietor_name": "Same as 'Signed by' - used for map matching",
              "title_number": "Same as 'Plot No' - used for map matching",
              "sketch_box_1000": [ymin, xmin, ymax, xmax]
            }

            Rules for Spatial Detection:
            - If is_wayleave_consent_form is false, return null for all other fields except is_wayleave_consent_form.
            - If true, identify the empty rectangular box in the bottom half intended for a site sketch and return its bounding box as [ymin, xmin, ymax, xmax] on a scale of 0-1000.
            """
            
            import time
            retries = 5
            response = None
            for attempt in range(retries):
                try:
                    response = self.client.models.generate_content(
                        model=self.model_name,
                        contents=[
                            prompt,
                            types.Part.from_bytes(data=img_data, mime_type="image/png")
                        ]
                    )
                    break # Success
                except Exception as e:
                    err_msg = str(e).upper()
                    # Retry on rate limits or service unavailability
                    if any(x in err_msg for x in ["503", "UNAVAILABLE", "RATE_LIMIT", "QUOTA"]):
                        if attempt < retries - 1:
                            wait_time = (attempt + 1) * 3  # 3s, 6s, 9s, 12s...
                            print(f"    [Retry {attempt+1}] Gemini API busy/unavailable: {e}. Waiting {wait_time}s...")
                            time.sleep(wait_time)
                            continue
                    
                    print(f"    [Page {page_num+1} Error] Failed: {e}")
                    return None

            if not response or not response.text:
                return None
                
            text = response.text.strip()
            # More robust JSON cleaning
            if "```json" in text:
                text = text.split("```json")[-1].split("```")[0].strip()
            elif "```" in text:
                text = text.split("```")[-1].split("```")[0].strip()
            
            try:
                data = json.loads(text)
            except json.JSONDecodeError as je:
                print(f"    [Page {page_num+1} Error] Invalid JSON from AI: {je}\nResponse text: {text}")
                return None
            
            # Add PDF page dimensions for coordinate conversion
            data["page_width"] = page.rect.width
            data["page_height"] = page.rect.height
            data["rotation"] = page.rotation
            
            return data
        except Exception as e:
            print(f"    [Page {page_num+1} Error] {e}")
            return None

class SitePlanLocator:
    def __init__(self, site_plan_path):
        self.path = site_plan_path
        self.doc = fitz.open(site_plan_path)
        self.index = [] # List of {text, page, rect}
        self._build_index()

    def _build_index(self):
        print("Indexing Site Plan (this may take a moment)...")
        # Optimization: We currently use direct fitz search, no indexing needed for now.
        pass

    def close(self):
        """Explicitly close the PDF document."""
        if hasattr(self, 'doc') and self.doc:
            try:
                self.doc.close()
            except Exception:
                pass
    
    def search(self, name, title_number):
        """
        Search for Proprietor Name (Fuzzy) or Plot Number (Exact/Vicinity).
        name: The main Proprietor name to search for.
        Returns: {page, rect, method} or None.
        """
        import re
        best_match = None
        best_score = 0
        
        # 1. Search by Name
        if name:
            print(f"  Searching for Name '{name}'...", end="", flush=True)
            
            # Words > 2 chars to avoid initials/noise
            name_parts = [p for p in name.lower().split() if len(p) > 2]
            if not name_parts: return None
            
            for page_num, page in enumerate(self.doc):
                if page_num % 10 == 0: print(".", end="", flush=True)
                
                # We search for ALL parts to handle cases where one is misspelled or missing
                # We collect every hit and score its surroundings
                page_best_score = 0
                page_best_rect = None
                
                for part in name_parts:
                    hits = page.search_for(part)
                    for hit in hits:
                        # Expansion: Get text around the hit to identify the full name block
                        search_box = hit + (-200, -15, 200, 15) 
                        text_block = page.get_textbox(search_box).replace("\n", " ").strip().lower()
                        if not text_block: continue

                        # THE 2-TOKEN RULE (Fuzzy):
                        # Count how many of our unique name parts have a close fuzzy match in this block
                        words_in_block = text_block.split()
                        matches = 0
                        for p in name_parts:
                            # Check if part 'p' matches any word in the block fuzzy-wise
                            if any(fuzz.ratio(p, w) > 85 for w in words_in_block):
                                matches += 1
                        
                        if matches >= 2:
                            score = fuzz.partial_token_set_ratio(name.lower(), text_block)
                            if score > page_best_score:
                                page_best_score = score
                                page_best_rect = hit
                
                if page_best_score > best_score:
                    best_score = page_best_score
                    best_match = {"page": page_num, "rect": page_best_rect, "method": f"name_match ({name}) with {best_score}% confidence"}
                        
            print(" Done.")

        if best_match and best_score > 80:
            return best_match
        
        # 2. Try Plot Number 
        numbers = re.findall(r'\d+', title_number)
        if not numbers:
             return None
        
        plot_no = numbers[-1] 
        print(f"  Searching for Plot '{plot_no}'...", end="", flush=True)
        
        for page_num, page in enumerate(self.doc):
             hits = page.search_for(plot_no)
             for rect in hits:
                 word = page.get_text("text", clip=rect).strip()
                 clean_word = re.sub(r'[^\w]', '', word)
                 
                 if clean_word == plot_no:
                     # VICINITY CHECK
                     search_area = rect + (-500, -500, 500, 500)
                     nearby_text = page.get_textbox(search_area)
                     
                     best_v_score = 0
                     best_v_rect = rect
                     best_v_name = ""

                     if name:
                         
                         # To handle "Henry Tabut" vs "Henry Bitok" in the same vicinity,
                         # we must check EVERY occurrence of name parts in this area
                         name_parts = [p for p in name.lower().split() if len(p) > 2]
                         for part in name_parts:
                             part_hits = page.search_for(part, clip=search_area)
                             for p_hit in part_hits:
                                 # Score the specific line this part is on
                                 line_box = p_hit + (-200, -10, 200, 10)
                                 line_text = page.get_textbox(line_box).replace("\n", " ").strip().lower()
                                 
                                 # THE 2-TOKEN RULE (Fuzzy):
                                 words_in_line = line_text.split()
                                 matches = 0
                                 for p in name_parts:
                                     if any(fuzz.ratio(p, w) > 85 for w in words_in_line):
                                         matches += 1
                                 
                                 if matches >= 2:
                                     score = fuzz.partial_token_set_ratio(name.lower(), line_text)
                                     if score > best_v_score:
                                         best_v_score = score
                                         best_v_rect = p_hit
                                         best_v_name = name

                     if best_v_score > 75:
                         return {
                             "page": page_num, 
                             "rect": best_v_rect, 
                             "method": f"vicinity_match (Plot {plot_no}, Found {best_v_name} with score {best_v_score})"
                         }
                     
        return None

    def get_snippet(self, search_result, output_path, aspect_ratio=1.0):
        """
        Renders a RECTANGULAR snippet that matches the target box aspect ratio.
        We use a LARGE base_size to ensure we don't crop out context like names.
        """
        if not search_result:
            return False
            
        page = self.doc[search_result["page"]]
        center = search_result["rect"]
        
        # Sweet spot: 500 units balances legibility and context.
        base_size = 500 
        
        # Adjust dimensions to match the box aspect ratio
        if aspect_ratio >= 1.0: # Landscape/Square target
            crop_w = base_size
            crop_h = base_size / aspect_ratio
        else: # Portrait target
            crop_h = base_size
            crop_w = base_size * aspect_ratio

        clip_rect = fitz.Rect(
            center.x0 - crop_w/2, 
            center.y0 - crop_h/2,
            center.x1 + crop_w/2,
            center.y1 + crop_h/2
        )
        
        # Render
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=clip_rect) 
        pix.save(output_path)
        return True

class PDFProcessor:
    @staticmethod
    def overlay_snippet(consent_pdf_path, snippet_img_path, target_box_1000, output_path, page_index=0, rotation=0):
        # Explicitly cast to int as pandas/numpy types can cause TypeErrors in fitz
        page_index = int(page_index)
        
        doc = fitz.open(consent_pdf_path)
        
        new_doc = fitz.open()
        new_doc.insert_pdf(doc, from_page=page_index, to_page=page_index)
        page = new_doc[0]
        
        # Gemini coordinates are 0-1000 relative to the VISUAL page (what the AI sees).
        # We need to map [ymin, xmin, ymax, xmax] (0-1000) to Internal PDF coordinates.
        
        ymin, xmin, ymax, xmax = target_box_1000
        
        # 1. Map to Visual Points (in PDF points)
        # page.rect is the visual rectangle (width and height already match the rotated view)
        v_w = page.rect.width
        v_h = page.rect.height
        
        v_p0 = fitz.Point(xmin * v_w / 1000, ymin * v_h / 1000)
        v_p1 = fitz.Point(xmax * v_w / 1000, ymax * v_h / 1000)
        
        # INCREASE PADDING: Use 5% padding to create a "centered/floating" look
        padding_x = (v_p1.x - v_p0.x) * 0.05
        padding_y = (v_p1.y - v_p0.y) * 0.05
        v_p0.x += padding_x
        v_p0.y += padding_y
        v_p1.x -= padding_x
        v_p1.y -= padding_y

        # 2. Transform Visual Points back to Internal PDF Space
        # page.rotation_matrix maps internal -> visual. We need visual -> internal.
        mi = ~page.rotation_matrix
        
        i_p0 = v_p0 * mi
        i_p1 = v_p1 * mi
        
        # Create the internal rectangle
        rect = fitz.Rect(i_p0, i_p1)
        rect.normalize()
        
        try:
            # 3. Insert Image
            page.insert_image(rect, filename=snippet_img_path, rotate=rotation)
            new_doc.save(output_path)
            # CRITICAL: Close documents to release file handles
            new_doc.close()
            doc.close()
            return True
        except Exception as e:
            print(f"Error overlaying PDF: {e}")
            if 'new_doc' in locals(): new_doc.close()
            if 'doc' in locals(): doc.close()
            return False

class ExcelWriter:
    @staticmethod
    def _copy_font(f):
        return Font(name=f.name, size=f.size, bold=f.bold, italic=f.italic,
                    vertAlign=f.vertAlign, underline=f.underline, strike=f.strike, color=f.color)

    @staticmethod
    def _copy_border(b):
        return Border(left=copy(b.left), right=copy(b.right), top=copy(b.top),
                      bottom=copy(b.bottom), diagonal=copy(b.diagonal),
                      diagonal_direction=b.diagonal_direction, outline=b.outline,
                      vertical=copy(b.vertical), horizontal=copy(b.horizontal))

    @staticmethod
    def _copy_align(a):
        return Alignment(horizontal=a.horizontal, vertical=a.vertical,
                         text_rotation=a.text_rotation, wrap_text=a.wrap_text,
                         shrink_to_fit=a.shrink_to_fit, indent=a.indent)

    @classmethod
    def append_data(cls, template_path, data_list, output_buffer):
        """Writes extracted data to Excel, matching row-3 formatting."""
        wb = load_workbook(template_path)
        ws = wb.active

        # Find real last data row (skip empty formatted rows)
        last_row = 1
        for r in range(1, ws.max_row + 1):
            if ws.cell(r, 1).value is not None:
                last_row = r

        start = last_row + 1
        template = ws[3]  # Row 3 = example data row (Goudy Old Style, 8pt, not bold)

        for i, data in enumerate(data_list):
            row = start + i

            # S/NO
            prev = ws.cell(row - 1, 1).value
            try:
                sno = int(prev) + 1
            except (ValueError, TypeError):
                sno = i + 1
            ws.cell(row, 1, sno)

            # Data columns
            for col, key in COL_MAP.items():
                if col == 1:
                    continue  # S/NO handled above
                val = data.get(key, "") if key else ""
                ws.cell(row, col, val)

            # Copy formatting from template row
            for col in range(1, 15):
                src = template[col - 1]
                tgt = ws.cell(row, col)
                if src.has_style:
                    tgt.font = cls._copy_font(src.font)
                    tgt.border = cls._copy_border(src.border)
                    tgt.alignment = cls._copy_align(src.alignment)

        wb.save(output_buffer)
        return len(data_list)
