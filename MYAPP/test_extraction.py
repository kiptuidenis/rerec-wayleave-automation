
import os
import google.generativeai as genai
import json

API_KEY = os.environ.get("GEMINI_API_KEY")
if not API_KEY:
    print("API Key not found", flush=True)
    exit(1)

genai.configure(api_key=API_KEY)

model = genai.GenerativeModel("gemini-1.5-flash")

IMAGE_DIR = "Sample Images"

def test():
    print("Starting test...", flush=True)
    if not os.path.exists(IMAGE_DIR):
        print(f"Directory {IMAGE_DIR} not found.", flush=True)
        return

    files = [f for f in os.listdir(IMAGE_DIR) if f.lower().endswith(('.jpg', '.png'))]
    if not files:
        print("No images found.", flush=True)
        return

    image_path = os.path.join(IMAGE_DIR, files[0])
    print(f"Testing with: {image_path}", flush=True)
    
    try:
        sample_file = genai.upload_file(image_path)
        print(f"Uploaded: {sample_file.uri}", flush=True)
        
        prompt = """
        Extract details in JSON:
        {
          "Constituency": "",
          "County": "",
          "Plot No": "",
          "Owned by": "",
          "Signed by": "",
          "Relationship": "",
          "Consent Signed": ""
        }
        """
        response = model.generate_content([sample_file, prompt])
        print(f"Raw Response: {response.text}", flush=True)
    except Exception as e:
        print(f"Error: {e}", flush=True)

if __name__ == "__main__":
    test()
