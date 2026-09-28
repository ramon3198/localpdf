# One Word job for scripts/pdf-to-docx-check.mjs, run through the shared Word gateway (-Gateway: the script that owns
# Word's lock, e.g. word-export.ps1 -In <file> -Out <file>), with two fixes around it:
#  - Word's PDF import (PDF -> DOCX) starts PDFREFLOW.EXE, which shows a modal notice ("Word will now convert your PDF
#    to an editable Word document...") that nobody answers in automation, so the job hangs. For PDF input this presses
#    the notice's OK button (AutomationId 1) and leaves "don't show this message again" untouched.
#  - The gateway's Word.Quit() leaves WINWORD.EXE running (~200 MB per job). The Word and PDF-reflow processes started
#    during this job are ended afterwards, but only when exactly one Word process started while the job ran (so it is
#    certainly this job's); otherwise nothing is ended and the output says so.
#   powershell -NoProfile -ExecutionPolicy Bypass -File pdf-to-docx-word-job.ps1 -Gateway word-export.ps1 -In a.pdf -Out a.docx
# Output: the gateway's lines ("ok pages=N" on success), then "notice: ..." and "cleanup: ..." lines.
param(
    [Parameter(Mandatory = $true)][string]$Gateway,
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$TimeoutSec = 900
)
$ErrorActionPreference = "Stop"
# UTF-8 for this script's output and for the gateway's (it shares this console), so Word's messages keep their accents.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]

function Get-Started($name) {
    $map = @{}
    foreach ($p in @(Get-Process $name -ErrorAction SilentlyContinue)) { try { $map[$p.Id] = $p.StartTime } catch {} }
    return $map
}

function Get-Dialogs($procId) {
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $procId)
    return @($AE::RootElement.FindAll($Scope::Children, $cond) | Where-Object { $_.Current.ClassName -in @("NUIDialog", "#32770", "bosa_sdm_msword") })
}

function Get-DialogText($dialog) {
    $texts = $dialog.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))
    return (@($texts | ForEach-Object { $_.Current.Name }) -join " ").Trim()
}

# The PDF-conversion notice: a PDFREFLOW dialog that mentions "PDF" and has a "don't show again" checkbox.
function Confirm-ReflowNotice($since, $known) {
    $done = @()
    foreach ($r in @(Get-Process PDFREFLOW -ErrorAction SilentlyContinue)) {
        if ($known.ContainsKey($r.Id)) { continue }
        try { if ($r.StartTime -lt $since) { continue } } catch { continue }
        foreach ($d in (Get-Dialogs $r.Id)) {
            $text = Get-DialogText $d
            $check = $d.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::CheckBox)))
            $ok = $d.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, "1")))
            if ($ok -and $check -and $text -match "PDF") {
                $ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                $done += "notice: answered PDF-conversion notice of PDFREFLOW $($r.Id)"
            }
        }
    }
    return $done
}

$isPdf = $In.ToLower().EndsWith(".pdf")
$wordBefore = Get-Started "WINWORD"
$reflowBefore = Get-Started "PDFREFLOW"
$tmpOut = [System.IO.Path]::GetTempFileName()
$tmpErr = [System.IO.Path]::GetTempFileName()
$argLine = "-NoProfile -ExecutionPolicy Bypass -File `"$Gateway`" -In `"$In`" -Out `"$Out`""
$child = Start-Process -FilePath "powershell.exe" -ArgumentList $argLine -NoNewWindow -PassThru -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
$null = $child.Handle
$childStart = $child.StartTime
function Get-NewProcesses($name, $before, $since) {
    return @((Get-Started $name).GetEnumerator() | Where-Object { -not $before.ContainsKey($_.Key) -and $_.Value -ge $since.AddSeconds(-1) } | ForEach-Object { $_.Key })
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$notes = @()
$timedOut = $false
$blocked = $false
$dialogSince = $null
while (-not $child.HasExited) {
    if ($isPdf) { $notes += Confirm-ReflowNotice $childStart $reflowBefore }
    # A dialog that stays open in this job's own Word (or PDF-reflow) process is a question nobody will answer
    # (e.g. "Word found unreadable content"): report it and end the job instead of waiting for the timeout.
    $newWordNow = Get-NewProcesses "WINWORD" $wordBefore $childStart
    $dialogs = @()
    if ($newWordNow.Count -eq 1) {
        foreach ($id in @($newWordNow) + (Get-NewProcesses "PDFREFLOW" $reflowBefore $childStart)) { $dialogs += Get-Dialogs $id }
    }
    if ($dialogs.Count) {
        if (-not $dialogSince) { $dialogSince = Get-Date }
        elseif (((Get-Date) - $dialogSince).TotalSeconds -gt 8) {
            foreach ($d in $dialogs) { $notes += "dialog: '$($d.Current.Name)': $(Get-DialogText $d)" }
            $blocked = $true
            try { Stop-Process -Id $child.Id -Force } catch {}
            break
        }
    } else { $dialogSince = $null }
    if ((Get-Date) -gt $deadline) {
        $timedOut = $true
        try { Stop-Process -Id $child.Id -Force } catch {}
        break
    }
    Start-Sleep -Milliseconds 300
}
$child.WaitForExit(5000) | Out-Null
$childEnd = if ($child.HasExited) { $child.ExitTime } else { Get-Date }
$code = if ($timedOut) { 124 } elseif ($blocked) { 125 } elseif ($null -ne $child.ExitCode) { $child.ExitCode } else { 1 }

# Processes started while the gateway ran: this job's when there is exactly one new Word process.
$newWord = @((Get-Started "WINWORD").GetEnumerator() | Where-Object { -not $wordBefore.ContainsKey($_.Key) -and $_.Value -ge $childStart.AddSeconds(-1) -and $_.Value -le $childEnd.AddSeconds(1) } | ForEach-Object { $_.Key })
$newReflow = @((Get-Started "PDFREFLOW").GetEnumerator() | Where-Object { -not $reflowBefore.ContainsKey($_.Key) -and $_.Value -ge $childStart.AddSeconds(-1) -and $_.Value -le $childEnd.AddSeconds(1) } | ForEach-Object { $_.Key })
if ($newWord.Count -eq 1) {
    $stopped = @()
    $helpers = @(Get-CimInstance Win32_Process -Filter "Name='ai.exe'" | Where-Object { $_.ParentProcessId -eq $newWord[0] } | ForEach-Object { $_.ProcessId })
    foreach ($id in @($newWord) + $newReflow + $helpers) {
        try { Stop-Process -Id $id -Force -ErrorAction Stop; $stopped += $id } catch {}
    }
    $notes += "cleanup: ended $($stopped.Count) process(es) of this job ($($stopped -join ', '))"
} elseif ($newWord.Count -gt 1) {
    $notes += "cleanup: skipped, $($newWord.Count) Word processes started during the job (not only this job's)"
}

Get-Content -LiteralPath $tmpOut -Encoding UTF8 -ErrorAction SilentlyContinue
$err = (Get-Content -LiteralPath $tmpErr -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
if ($err) { Write-Output ("gateway error: " + ($err -replace "\s+", " ").Trim()) }
if ($timedOut) { Write-Output "timeout: gateway still running after $TimeoutSec s" }
if ($blocked) { Write-Output "blocked: Word kept a dialog open, job ended" }
$notes | Where-Object { $_ } | ForEach-Object { Write-Output $_ }
Remove-Item -LiteralPath $tmpOut, $tmpErr -ErrorAction SilentlyContinue
exit $code
