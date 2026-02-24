
import os
import google.generativeai as genai

API_KEY = os.environ.get("GEMINI_API_KEY")
if not API_KEY:
    print("API Key not found", flush=True)
    exit(1)

genai.configure(api_key=API_KEY)

print("Listing models...", flush=True)
for m in genai.list_models():
  if 'generateContent' in m.supported_generation_methods:
    print(m.name, flush=True)
