# Word gateway for scripts/pdf-to-docx-check.mjs: exports a .docx to PDF with the installed Microsoft Word (invisible).
# One Word job at a time on this machine: every caller waits for the same lock file (%TEMP%\localpdf-word-export.lock).
#   powershell -NoProfile -ExecutionPolicy Bypass -File pdf-to-docx-word-export.ps1 -In C:\path\file.docx -Out C:\path\file.pdf
#
# Word.Quit() does not end the WINWORD.EXE that COM automation started, so this script ends the process it started
# (identified while holding the lock, so it can only be this job's) and a watchdog ends it if the job hangs.
# Word's own PDF -> DOCX import is not offered: it opens a PDF-conversion notice that blocks automation.
param(
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$TimeoutSec = 180,
    [string]$Lock = (Join-Path $env:TEMP "localpdf-word-export.lock")
)
$ErrorActionPreference = "Stop"
if ($In.ToLower().EndsWith(".pdf")) { throw "PDF input is not supported (Word's PDF import blocks on a notice); use the cached Word baselines" }

$handle = $null
$deadline = (Get-Date).AddMinutes(10)
while (-not $handle) {
    try { $handle = [System.IO.File]::Open($Lock, "OpenOrCreate", "ReadWrite", "None") }
    catch { if ((Get-Date) -gt $deadline) { throw "Word is busy (lock held for 10 minutes)" }; Start-Sleep -Milliseconds 400 }
}

$automation = { @(Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE'" | Where-Object { $_.CommandLine -match '/Automation|-Embedding' } | ForEach-Object { [int]$_.ProcessId }) }
$word = $null
$mine = @()
$watchdog = $null
try {
    $before = & $automation
    $word = New-Object -ComObject Word.Application
    $mine = @(& $automation | Where-Object { $before -notcontains $_ })
    if ($mine.Count) {
        $kill = ($mine | ForEach-Object { "taskkill /PID $_ /T /F" }) -join "; "
        $watchdog = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList "-NoProfile -Command `"Start-Sleep -Seconds $TimeoutSec; $kill`""
    }
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $inFull = (Resolve-Path -LiteralPath $In).Path
    $outFull = [System.IO.Path]::GetFullPath($Out)
    # Documents.Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
    $doc = $word.Documents.Open($inFull, $false, $true, $false)
    $doc.ExportAsFixedFormat($outFull, 17)   # wdExportFormatPDF
    $pages = $doc.ComputeStatistics(2)       # wdStatisticPages
    $doc.Close(0)
    Write-Output "ok pages=$pages"
}
finally {
    if ($word) {
        try { $word.Quit(0) } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) } catch {}
    }
    # The Word this job started (and its ai.exe helper) must not outlive the job.
    foreach ($id in $mine) { & taskkill /PID $id /T /F 2>&1 | Out-Null }
    if ($watchdog) { try { Stop-Process -Id $watchdog.Id -Force -ErrorAction Stop } catch {} }
    $handle.Close()
}
