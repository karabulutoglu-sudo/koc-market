# Odak hırsızı yakalayıcı: saniyede 4 kez (250 ms) ön plandaki (foreground)
# pencerenin süreç adını + başlığını zaman damgasıyla loglar. Kapatmak için süreci durdur.
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$log = "C:\KocMarket\_focus_thief_log.txt"
"=== Odak logger basladi $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (saniyede 4 / 250ms) ===" | Out-File -FilePath $log -Append -Encoding utf8
$lastName = ""
while ($true) {
  try {
    $h = [FgWin]::GetForegroundWindow()
    $procId = 0
    [void][FgWin]::GetWindowThreadProcessId($h, [ref]$procId)
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    $sb = New-Object System.Text.StringBuilder 512
    [void][FgWin]::GetWindowText($h, $sb, 512)
    $title = $sb.ToString()
    $name = if ($p) { $p.ProcessName } else { "(yok)" }
    # Odak DEGISTIGINDE yildizla isaretle (suclu tespitini kolaylastirir)
    $mark = if ($name -ne $lastName) { " <== DEGISTI" } else { "" }
    $lastName = $name
    $line = "{0}`t{1}`t(pid {2})`t{3}{4}" -f (Get-Date -Format 'HH:mm:ss.fff'), $name, $procId, $title, $mark
    $line | Out-File -FilePath $log -Append -Encoding utf8
  } catch {
    "$(Get-Date -Format 'HH:mm:ss.fff')`tHATA`t$($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding utf8
  }
  Start-Sleep -Milliseconds 250
}
