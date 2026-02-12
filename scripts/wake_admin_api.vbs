Option Explicit

Dim shell, scriptDir, psScript, cmd
Set shell = CreateObject("WScript.Shell")

scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
psScript = scriptDir & "start_admin_api_once.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """"

shell.Run cmd, 0, False
