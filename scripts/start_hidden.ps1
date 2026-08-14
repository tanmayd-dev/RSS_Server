# RSS Server Background Launcher — uses WMI to start node truly headless
$nodePath = "C:\Program Files\nodejs\node.exe"
$scriptPath = "c:\Users\deshp\Projects\RSS_Server\scripts\keep_alive.cjs"
$workDir = "c:\Users\deshp\Projects\RSS_Server"

Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = "`"$nodePath`" `"$scriptPath`""
  CurrentDirectory = $workDir
} | Out-Null
