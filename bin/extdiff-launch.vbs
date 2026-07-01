' SVN Review — interactive desktop launcher.
'
' Run by the "SvnReviewDiff" scheduled task in the logged-on user's session
' (Apache itself lives in session 0 and cannot show a GUI). Drains every request
' file in data\extdiff-queue and performs its action on the user's desktop.
' Hosted by wscript.exe, so it has no console window and nothing flashes.
'
' Each request file is one field per line. Line 1 is the action verb:
'   run       <full command line>                  -> run any (quoted) command line
'   diff      <TortoiseProc.exe path> / <target>   -> TortoiseSVN diff (uses VS Code etc.)
'   open      <target>                             -> open with default associated program
'   explorer  <target>                             -> reveal a file (select) / open a folder

Option Explicit

Dim fso, sh, shApp, scriptDir, queueDir, f, ts, content, lines
Set fso   = CreateObject("Scripting.FileSystemObject")
Set sh    = CreateObject("WScript.Shell")
Set shApp = CreateObject("Shell.Application")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)         ' ...\svnreview\bin
queueDir  = fso.GetAbsolutePathName(scriptDir & "\..\data\extdiff-queue")

If Not fso.FolderExists(queueDir) Then WScript.Quit 0

For Each f In fso.GetFolder(queueDir).Files
    If LCase(fso.GetExtensionName(f.Name)) = "txt" Then
        On Error Resume Next
        Set ts = f.OpenAsTextStream(1)            ' 1 = ForReading
        content = ts.ReadAll
        ts.Close
        On Error GoTo 0

        lines = Split(content, vbLf)
        If UBound(lines) >= 0 Then Dispatch lines

        On Error Resume Next
        f.Delete True
        On Error GoTo 0
    End If
Next

Function Field(lines, i)
    If UBound(lines) >= i Then Field = Trim(Replace(lines(i), vbCr, "")) Else Field = ""
End Function

Sub Dispatch(lines)
    Dim action, a1, a2
    action = LCase(Field(lines, 0))
    a1 = Field(lines, 1)
    a2 = Field(lines, 2)

    Select Case action
        Case "run"                                ' a1 = a full command line (already quoted)
            If a1 <> "" Then sh.Run a1, 1, False
        Case "diff"                               ' a1 = TortoiseProc, a2 = target
            If a1 <> "" And a2 <> "" And fso.FileExists(a1) Then
                sh.Run """" & a1 & """ /command:diff /path:""" & a2 & """ /closeonend:0", 1, False
            End If
        Case "open"                               ' a1 = file/dir, default program
            If a1 <> "" Then shApp.ShellExecute a1, "", "", "open", 1
        Case "explorer"                           ' a1 = file (reveal+select) or folder (open)
            If a1 <> "" Then
                If fso.FolderExists(a1) Then
                    sh.Run "explorer.exe """ & a1 & """", 1, False
                Else
                    sh.Run "explorer.exe /select,""" & a1 & """", 1, False
                End If
            End If
    End Select
End Sub
