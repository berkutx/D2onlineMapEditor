# make_clones.ps1 -- N junction-based clones of the game dir for PARALLEL scen-tester runs.
#
# Each clone = real copies of the root FILES (exe/dll/ini, ~40MB) + junctions to every
# subdirectory EXCEPT Exports (each worker needs its own: the editor's load list shows the
# folder contents and the driver clicks the FIRST row, so one staged map per Exports).
# Globals/Imgs/... are shared via junctions -- the DB lock on load is handled by the
# runner's staggered starts (5s), not here.
#
# Also applies the HEADLESS config to each clone: the null-render C4dll-R.dll + ddraw.ini
# from the slasher dir, and ScenEditDatabase=0 (folder-browse load list) in Disciple.ini.
#
#   powershell -File make_clones.ps1 -Count 4
#   powershell -File make_clones.ps1 -Count 0   # remove all clones
param(
    [int]$Count = 4,
    [string]$Master = "C:\GOG Games\last_version\Game",
    [string]$SlasherDir = "C:\GOG Games\slasher_mns_2_4 - C4dll",
    [string]$CloneBase = "C:\GOG Games\last_version\Game_gc"
)

# drop existing clones (junctions are removed as links, never following into the target)
Get-Item "$CloneBase*" -ErrorAction SilentlyContinue | ForEach-Object {
    Get-ChildItem $_.FullName -Directory | ForEach-Object {
        if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { $_.Delete() } else { Remove-Item $_.FullName -Recurse -Force }
    }
    Remove-Item $_.FullName -Recurse -Force
    Write-Output ("removed " + $_.FullName)
}
if ($Count -lt 1) { Write-Output "clones removed"; exit 0 }

foreach ($i in 1..$Count) {
    $clone = "$CloneBase$i"
    New-Item -ItemType Directory -Path $clone | Out-Null
    # root files: real copies (the editor writes trace logs next to the exe)
    Get-ChildItem $Master -File | Copy-Item -Destination $clone
    # subdirs: junctions, except Exports (own, empty) and the corpus copies (not needed)
    Get-ChildItem $Master -Directory | ForEach-Object {
        if ($_.Name -eq "Exports" -or $_.Name -like "Exports - Copy*" -or $_.Name -like "Game_gc*") { return }
        New-Item -ItemType Junction -Path (Join-Path $clone $_.Name) -Target $_.FullName | Out-Null
    }
    New-Item -ItemType Directory -Path (Join-Path $clone "Exports") | Out-Null
    # headless config
    Copy-Item "$SlasherDir\C4dll-R.dll" "$clone\C4dll-R.dll" -Force
    Copy-Item "$SlasherDir\ddraw.ini" "$clone\ddraw.ini" -Force
    $dini = "$clone\Disciple.ini"
    (Get-Content $dini -Raw) -replace 'ScenEditDatabase=1', 'ScenEditDatabase=0' | Set-Content $dini -NoNewline
    Write-Output ("clone ready: " + $clone)
}
