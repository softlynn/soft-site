Option Explicit

Dim shell, scriptDir, runnerPath, cmd, exitCode
Set shell = CreateObject("WScript.Shell")

scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
runnerPath = scriptDir & "run_local_archive_task_once.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & runnerPath & """"

exitCode = shell.Run(cmd, 0, True)
WScript.Quit exitCode
