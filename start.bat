@echo off
echo [%date% %time%] Batch script launched by VBScript >> "c:\Users\deshp\Projects\RSS_Server\start_log.txt"
cd /d "c:\Users\deshp\Projects\RSS_Server"
"C:\Program Files\nodejs\node.exe" scripts\keep_alive.cjs >> "c:\Users\deshp\Projects\RSS_Server\start_log.txt" 2>&1
