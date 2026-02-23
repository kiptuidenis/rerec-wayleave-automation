
import subprocess
import sys
import os

# Add src to python path so run_automation can find workflow_lib
os.environ["PYTHONPATH"] = os.path.join(os.getcwd(), "src")

if __name__ == "__main__":
    print("Starting Wayleave Automation...")
    # Run the script using the current python executable
    result = subprocess.run([sys.executable, os.path.join("src", "run_automation.py")], cwd=os.getcwd())
    sys.exit(result.returncode)
