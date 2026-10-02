# Icone de l'outil dans la zone de notification (Windows PowerShell 5.1 + WinForms).
# Simple affichage pilote par le processus Node (apps/worker/src/tray/tray.ts), une ligne JSON par
# message :
#   Node -> icone (stdin)  : init (libelles), state (icone, statut, info-bulle), toast, exit
#   icone -> Node (stdout) : {"cmd":"dashboard"|"ready"|"scan"|"pause"|"log"|"quit"}
# Si Node disparait (stdin ferme), l'icone se retire ; si l'icone disparait, Node s'arrete
# proprement : jamais de processus invisible qui reste derriere.
# Fichier en ASCII : les textes accentues arrivent de Node, en JSON UTF-8.
param([Parameter(Mandatory = $true)][string]$IconDir)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$utf8 = New-Object System.Text.UTF8Encoding($false)
$script:out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$script:out.AutoFlush = $true
# StreamReader : sa lecture asynchrone ne bloque pas l'interface (contrairement a [Console]::In)
$script:in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)

function Send-Command([string]$cmd) {
  try { $script:out.WriteLine('{"cmd":"' + $cmd + '"}') } catch { }
}

$size = [System.Windows.Forms.SystemInformation]::SmallIconSize
$script:icons = @{}
foreach ($name in 'idle', 'running', 'paused', 'error') {
  $script:icons[$name] = New-Object System.Drawing.Icon((Join-Path $IconDir "tray-$name.ico"), $size)
}

$script:tray = New-Object System.Windows.Forms.NotifyIcon
$script:tray.Icon = $script:icons['idle']
$script:tray.Text = 'Outil contenu'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Add-Item([string]$cmd) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem
  $item.Text = $cmd
  if ($cmd) { $item.Tag = $cmd; $item.add_Click({ param($s, $e) Send-Command $s.Tag }) }
  [void]$menu.Items.Add($item)
  return $item
}
$script:items = @{}
$script:items['status'] = Add-Item ''
$script:items['status'].Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
foreach ($cmd in 'dashboard', 'ready', 'scan', 'pause') { $script:items[$cmd] = Add-Item $cmd }
$script:items['dashboard'].Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
foreach ($cmd in 'log', 'quit') { $script:items[$cmd] = Add-Item $cmd }
$script:tray.ContextMenuStrip = $menu

# Clic gauche ou clic sur une notification : tableau de bord
$script:tray.add_MouseClick({
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send-Command 'dashboard' }
  })
$script:tray.add_BalloonTipClicked({ Send-Command 'dashboard' })

function Stop-Tray {
  $script:timer.Stop()
  $script:tray.Visible = $false
  $script:tray.Dispose()
  [System.Windows.Forms.Application]::ExitThread()
}

function Limit([string]$text, [int]$max) {
  if ($text.Length -le $max) { return $text }
  return $text.Substring(0, $max - 1) + [char]0x2026
}

function Invoke-Message([string]$line) {
  $m = ConvertFrom-Json $line
  switch ($m.type) {
    'init' {
      foreach ($p in $m.labels.PSObject.Properties) {
        if ($script:items.ContainsKey($p.Name)) { $script:items[$p.Name].Text = $p.Value }
      }
      $script:tray.Visible = $true
    }
    'state' {
      if ($script:icons.ContainsKey($m.icon)) { $script:tray.Icon = $script:icons[$m.icon] }
      # Info-bulle : 63 caracteres au plus (limite de NotifyIcon sous .NET Framework)
      $script:tray.Text = Limit $m.tooltip 63
      $script:items['status'].Text = $m.status
      $script:items['pause'].Text = $m.pauseLabel
      $script:items['pause'].Enabled = [bool]$m.canPause
      $script:items['scan'].Enabled = [bool]$m.canScan
      $script:items['quit'].Text = $m.quitLabel
    }
    'toast' {
      $script:tray.BalloonTipTitle = Limit $m.title 63
      $script:tray.BalloonTipText = Limit $m.text 255
      if ($m.error) {
        $script:tray.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Error
      } else {
        $script:tray.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
      }
      $script:tray.ShowBalloonTip(10000)
    }
    'exit' { Stop-Tray }
  }
}

# Lecture de stdin sans bloquer : une lecture asynchrone, relevee par un minuteur de l'interface
$script:pending = $script:in.ReadLineAsync()
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 100
$script:timer.add_Tick({
    try {
      while ($script:pending.IsCompleted) {
        if ($script:pending.IsFaulted) { Stop-Tray; return }
        $line = $script:pending.Result
        if ($null -eq $line) { Stop-Tray; return }
        $script:pending = $script:in.ReadLineAsync()
        if ($line.Trim()) {
          try { Invoke-Message $line } catch { [Console]::Error.WriteLine("message ignore : $_") }
        }
      }
    } catch {
      [Console]::Error.WriteLine("erreur : $_")
      Stop-Tray
    }
  })
$script:timer.Start()

[System.Windows.Forms.Application]::Run()
foreach ($icon in $script:icons.Values) { $icon.Dispose() }
