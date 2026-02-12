Option Explicit

Dim shell, scriptDir, runnerPath, cmd
Set shell = CreateObject("WScript.Shell")

scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
runnerPath = scriptDir & "run_local_archive_task_once.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & runnerPath & """"

shell.Run cmd, 0, False
