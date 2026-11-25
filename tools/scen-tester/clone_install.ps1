# clone_install.ps1 -- a throw-away clone of ONE mod install, to run ITS ScenEdit.exe under
# scen_tester.py without touching the install (always check a map against the editor of the mod
# it was made for: another mod's database rejects it for its own reasons).
#
#   powershell -File clone_install.ps1 -Master "C:\Games\SomeMod" -Clone "C:\Temp\gc\somemod" -Wrapper "C:\Games\WithCncDdraw"
#   python scen_tester.py --batch "C:\maps\folder" --editor "C:\Temp\gc\somemod\ScenEdit.exe" --kill-exit
#   powershell -File clone_install.ps1 -Clone "C:\Temp\gc\somemod" -Remove
#
# The clone costs about a megabyte:
#   * exe/dll/asi of the root   -> hard links (same volume as the install; nothing writes into them)
#   * other small root files    -> real copies (the editor rewrites its ini, the mod writes logs)
#   * every subfolder           -> a junction to the install, EXCEPT Exports: an own, empty folder
#                                  (the tester stages one map there and clicks the first row)
#   * renderer wrapper          -> cnc-ddraw (a C4dll-R.dll that reads ddraw.ini) from -Wrapper,
#                                  windowed, `renderer=gdi`: the same predictable window for every
#                                  mod, whatever wrapper the mod ships
#   * Disciple.ini              -> ScenEditDatabase=0 (the load list browses the folder, not the
#                                  database) and DisplaySize=0 (the tester's click points are for
#                                  the 1024x768 editor screen)
#
# -Remove unlinks the junctions AS LINKS (never following them into the install) and refuses to
# touch a folder it did not create (no .scentest-clone marker) or one where a link is left.
param(
    [string]$Master,
    [Parameter(Mandatory)][string]$Clone,
    [string]$Wrapper,
    [string]$Renderer = 'gdi',
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$marker = '.scentest-clone'

if ($Remove) {
    $full = [IO.Path]::GetFullPath($Clone)
    if (-not (Test-Path -LiteralPath $full)) { "no such clone: $full"; return }
    if (-not (Test-Path -LiteralPath (Join-Path $full $marker))) { throw "not a clone made by this script (no $marker): $full" }
    $unlinked = 0
    foreach ($d in [IO.Directory]::GetDirectories($full)) {
        $info = [IO.DirectoryInfo]::new($d)
        if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $info.Delete()      # non-recursive: removes the junction itself, not what it points to
            $unlinked++
        }
    }
    $left = @(Get-ChildItem -LiteralPath $full -Recurse -Force -Attributes ReparsePoint)
    if ($left.Count) { throw "links still present, nothing else removed: $($left.FullName -join ', ')" }
    Remove-Item -LiteralPath $full -Recurse -Force
    "removed clone $full ($unlinked junctions unlinked)"
    return
}

if (-not $Master) { throw '-Master <mod install folder> is required' }
if (-not (Test-Path -LiteralPath (Join-Path $Master 'ScenEdit.exe'))) { throw "no ScenEdit.exe in $Master" }
if (-not $Wrapper) { $Wrapper = $Master }
foreach ($f in 'C4dll-R.dll', 'ddraw.ini') {
    if (-not (Test-Path -LiteralPath (Join-Path $Wrapper $f))) {
        throw "-Wrapper must be a folder with cnc-ddraw as C4dll-R.dll and its ddraw.ini; no $f in $Wrapper"
    }
}
if (Test-Path -LiteralPath $Clone) { throw "clone folder already exists: $Clone" }
New-Item -ItemType Directory -Path $Clone -Force | Out-Null
Set-Content -LiteralPath (Join-Path $Clone $marker) -Value "clone of $Master, made by tools/scen-tester/clone_install.ps1" -Encoding ascii

$link = @('.exe', '.dll', '.asi')
$skip = @('.log', '.zip', '.backup', '.bak', '.trace2', '.min1', '.min2', '.i64', '.pdb', '.til', '.nam', '.id0', '.id1', '.id2', '.md', '.ps1')
$nLink = 0; $nCopy = 0
foreach ($f in Get-ChildItem -LiteralPath $Master -File -Force) {
    $ext = $f.Extension.ToLowerInvariant()
    if ($skip -contains $ext) { continue }
    $dst = Join-Path $Clone $f.Name
    if ($link -contains $ext) { New-Item -ItemType HardLink -Path $dst -Target $f.FullName | Out-Null; $nLink++ }
    else { Copy-Item -LiteralPath $f.FullName -Destination $dst; $nCopy++ }
}
$nJunction = 0
foreach ($d in Get-ChildItem -LiteralPath $Master -Directory -Force) {
    if ($d.Name -like 'Exports*') { continue }
    New-Item -ItemType Junction -Path (Join-Path $Clone $d.Name) -Target $d.FullName | Out-Null
    $nJunction++
}
New-Item -ItemType Directory -Path (Join-Path $Clone 'Exports') | Out-Null

# the renderer wrapper: drop the linked name (the install's own file stays), put a real copy
$dll = Join-Path $Clone 'C4dll-R.dll'
if (Test-Path -LiteralPath $dll) { Remove-Item -LiteralPath $dll -Force }
Copy-Item -LiteralPath (Join-Path $Wrapper 'C4dll-R.dll') -Destination $dll
$latin1 = [Text.Encoding]::GetEncoding(28591)   # byte-preserving: the ini files are ANSI
$ddraw = [IO.File]::ReadAllText((Join-Path $Wrapper 'ddraw.ini'), $latin1)
$ddraw = [regex]::Replace($ddraw, '(?m)^renderer=.*?(\r?)$', "renderer=$Renderer`$1")
$ddraw = [regex]::Replace($ddraw, '(?m)^shader=.*?(\r?)$', 'shader=$1')
[IO.File]::WriteAllText((Join-Path $Clone 'ddraw.ini'), $ddraw, $latin1)

$iniPath = Join-Path $Clone 'Disciple.ini'
$ini = [IO.File]::ReadAllText($iniPath, $latin1)
foreach ($key in 'ScenEditDatabase', 'DisplaySize') {
    if ($ini -match "(?m)^$key=") { $ini = [regex]::Replace($ini, "(?m)^$key=.*?(\r?)`$", "$key=0`$1") }
    else { $ini = [regex]::new('(?m)^\[Disciple\](\r?)$').Replace($ini, "[Disciple]`$1`n$key=0`$1", 1) }
}
[IO.File]::WriteAllText($iniPath, $ini, $latin1)

"clone ready: $Clone"
"  hard links: $nLink, copies: $nCopy, junctions: $nJunction; renderer=$Renderer; ScenEditDatabase=0; DisplaySize=0"
