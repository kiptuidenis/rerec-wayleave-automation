
import subprocess
import sys
import os

# Set Python Path
os.environ["PYTHONPATH"] = os.path.join(os.getcwd(), "src")

if __name__ == "__main__":
    print("Launching Streamlit UI...")
    # Launch streamlit using the current python executable to ensure environment parity
    try:
        subprocess.run([sys.executable, "-m", "streamlit", "run", "src/app.py"], check=True)
    except KeyboardInterrupt:
        print("\nUI Stopped.")
