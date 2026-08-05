Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workbookPath = [IO.Path]::GetFullPath((Join-Path $repo 'focus-taxonomy.xlsx'))
if (-not $workbookPath.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Workbook resolved outside the repository: $workbookPath"
}

# Ask the real userscript for its scores, then independently rebuild the
# contribution breakdown and assert it reaches the same score. That keeps this
# sheet rerunnable without turning it into a second unverified implementation.
$nodeScript = @'
const { loadUserscript, loadFixture } = require('./tests/load-userscript');
const { exports: x } = loadUserscript();
const data = x.parsePayload(loadFixture());
// balancedScores returns a lexicographic vector [group, score]; the score
// element already has the basis applied, so nothing here divides again.
const [groupRanks, scores] = x.balancedScores(data.courses, data.completedIds, 'per-day');
const registry = x.focusRegistry(data.courses).entries;
const gainKeys = new Set([
  'Gym Gain Bonus Defense',
  'Gym Gain Bonus Dexterity',
  'Gym Gain Bonus Speed',
  'Gym Gain Bonus Strength',
  'General Progression Bonuses Education Working Stat Rewards',
  'Crime & Jail Bonuses Crime Experience Gain',
  'Crime & Jail Bonuses Crime Skill Progression',
]);
const educationKey = 'General Progression Bonuses Education Working Stat Rewards';
const groupRanks_expected = [2, 1, 0];
const groupNames = ['Gain multipliers', 'Quantified benefits', 'Unlocks and unscored'];

let completedWorkingStats = 0;
for (const id of data.completedIds) {
  for (const value of x.workingStatsFor(data.courses.get(id)).values()) completedWorkingStats += value;
}

const rowsByCourse = new Map();
for (const row of registry) {
  if (!rowsByCourse.has(row.courseId)) rowsByCourse.set(row.courseId, []);
  rowsByCourse.get(row.courseId).push(row);
}
const contributions = new Map();
function add(courseId, type, label, value, converted) {
  if (!Number.isFinite(value) || value < 0) return;
  if (!contributions.has(courseId)) contributions.set(courseId, new Map());
  const byType = contributions.get(courseId);
  const old = byType.get(type);
  byType.set(type, {
    label,
    value: (old ? old.value : 0) + value,
    converted: converted || (old && old.converted) || false,
  });
}
for (const course of data.courses.values()) {
  for (const [stat, value] of x.workingStatsFor(course)) {
    add(course.id, `stat:${stat}`, stat, value, false);
  }
}
for (const row of registry) {
  if (!Number.isFinite(row.magnitude)) continue;
  const type = x.focusKey(row.category, row.selection);
  const converted = type === educationKey;
  const value = converted
    ? completedWorkingStats * (row.magnitude / 100)
    : row.magnitude;
  add(row.courseId, type, type, value, converted);
}

const maxForType = new Map();
for (const byType of contributions.values()) {
  for (const [type, contribution] of byType) {
    const old = maxForType.get(type);
    if (old === undefined || contribution.value > old) maxForType.set(type, contribution.value);
  }
}

function compact(value) {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

const rows = [];
let catalogueIndex = 0;
for (const course of data.courses.values()) {
  const taxonomyRows = rowsByCourse.get(course.id) || [];
  const multiplier = taxonomyRows.some((row) => gainKeys.has(x.focusKey(row.category, row.selection)));
  const byType = contributions.get(course.id) || new Map();
  const group = multiplier ? 0 : byType.size > 0 ? 1 : 2;
  let normalised = 0;
  const parts = [];
  for (const [type, contribution] of byType) {
    const maximum = maxForType.get(type) || 0;
    const term = maximum > 0 ? contribution.value / maximum : 0;
    normalised += term;
    const conversion = contribution.converted ? ', 10% of completed education stats' : '';
    parts.push(`${contribution.label} ${compact(contribution.value)} (${term.toFixed(2)}${conversion})`);
  }
  const durationDays = course.duration / 86400;
  // Independent rebuild checked against the engine, so the sheet cannot drift
  // into showing a score the code does not actually rank on.
  const expected = normalised / durationDays;
  const actual = scores.get(course.id);
  if (Math.abs(expected - actual) > 0.000000001) {
    throw new Error(`sheet scoring drift for course ${course.id}: ${expected} != ${actual}`);
  }
  if (groupRanks.get(course.id) !== groupRanks_expected[group]) {
    throw new Error(`sheet grouping drift for course ${course.id}`);
  }
  rows.push({
    catalogueIndex: catalogueIndex++,
    prefix: course.prefix,
    course: course.name,
    group,
    groupName: groupNames[group],
    // The sheet shows the WITHIN-GROUP score, not the offset-laden one the
    // engine ranks on. The offsets (1e12 / 1e6 / 0) exist only to make the
    // group dominate after orderQueue's per-day division; printing them turns
    // a readable 1.73 into 1000000000001.7285, which reads as a bug to anyone
    // reviewing the layout. Group is already its own column, so the offset
    // carries no information here that the sheet does not already show.
    score: normalised,
    durationDays,
    scorePerDay: actual,
    // Ranking still uses the real engine value, so the sheet's row order is
    // the engine's order and not a re-derivation of it.
    sortKey: groupRanks.get(course.id) * 1e9 + actual,
    contributions: parts.length ? parts.join(' + ') : 'No measurable contribution',
  });
}
rows.sort((a, b) => (b.sortKey - a.sortKey) || (a.catalogueIndex - b.catalogueIndex));
rows.forEach((row, index) => { row.rank = index + 1; });
process.stdout.write(JSON.stringify({ rows, completedWorkingStats }));
'@

Push-Location $repo
try {
  $json = $nodeScript | & node -
  if ($LASTEXITCODE -ne 0) { throw "Node scoring process exited $LASTEXITCODE" }
} finally {
  Pop-Location
}
$data = $json | ConvertFrom-Json
if ($data.rows.Count -ne 131) { throw "Expected 131 course rows, got $($data.rows.Count)" }

function Read-ZipEntryBytes([IO.Compression.ZipArchive]$Zip, [string]$Name) {
  $entry = $Zip.GetEntry($Name)
  if (-not $entry) { throw "Missing workbook part: $Name" }
  $stream = $entry.Open()
  try {
    $memory = [IO.MemoryStream]::new()
    try { $stream.CopyTo($memory); return $memory.ToArray() } finally { $memory.Dispose() }
  } finally { $stream.Dispose() }
}

function Read-ZipEntryText([IO.Compression.ZipArchive]$Zip, [string]$Name) {
  return [Text.Encoding]::UTF8.GetString((Read-ZipEntryBytes $Zip $Name))
}

function Write-ZipEntryText([IO.Compression.ZipArchive]$Zip, [string]$Name, [string]$Text) {
  $old = $Zip.GetEntry($Name)
  if ($old) { $old.Delete() }
  $entry = $Zip.CreateEntry($Name, [IO.Compression.CompressionLevel]::Optimal)
  $stream = $entry.Open()
  try {
    $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
    try { $writer.Write($Text) } finally { $writer.Dispose() }
  } finally { $stream.Dispose() }
}

function Xml-ToString([xml]$Document) {
  $settings = [Xml.XmlWriterSettings]::new()
  $settings.Encoding = [Text.UTF8Encoding]::new($false)
  $settings.Indent = $false
  $settings.OmitXmlDeclaration = $false
  $memory = [IO.MemoryStream]::new()
  try {
    $writer = [Xml.XmlWriter]::Create($memory, $settings)
    try { $Document.Save($writer) } finally { $writer.Dispose() }
    return [Text.Encoding]::UTF8.GetString($memory.ToArray())
  } finally { $memory.Dispose() }
}

function Hash-Bytes([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [Convert]::ToHexString($sha.ComputeHash($Bytes)) } finally { $sha.Dispose() }
}

function Excel-Column([int]$Number) {
  $name = ''
  while ($Number -gt 0) {
    $Number--
    $name = [char](65 + ($Number % 26)) + $name
    $Number = [Math]::Floor($Number / 26)
  }
  return $name
}

function Escape-Xml([object]$Value) {
  return [Security.SecurityElement]::Escape([string]$Value)
}

function Text-Cell([string]$Reference, [object]$Value, [int]$Style) {
  return '<c r="' + $Reference + '" s="' + $Style + '" t="inlineStr"><is><t xml:space="preserve">' +
    (Escape-Xml $Value) + '</t></is></c>'
}

function Number-Cell([string]$Reference, [double]$Value, [int]$Style) {
  $number = $Value.ToString('R', [Globalization.CultureInfo]::InvariantCulture)
  return '<c r="' + $Reference + '" s="' + $Style + '"><v>' + $number + '</v></c>'
}

$mainNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
$relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
$packageRelNs = 'http://schemas.openxmlformats.org/package/2006/relationships'
$contentTypeNs = 'http://schemas.openxmlformats.org/package/2006/content-types'
$worksheetRelType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet'
$worksheetContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'

# Capture the original four worksheet parts before editing; verification below
# compares their raw bytes, not a semantic approximation.
$originalHashes = @{}
$readZip = [IO.Compression.ZipFile]::OpenRead($workbookPath)
try {
  [xml]$originalWorkbook = Read-ZipEntryText $readZip 'xl/workbook.xml'
  [xml]$originalRels = Read-ZipEntryText $readZip 'xl/_rels/workbook.xml.rels'
  $wbNs = [Xml.XmlNamespaceManager]::new($originalWorkbook.NameTable)
  $wbNs.AddNamespace('m', $mainNs)
  $wbNs.AddNamespace('r', $relNs)
  $relById = @{}
  foreach ($rel in $originalRels.Relationships.Relationship) { $relById[$rel.Id] = $rel.Target }
  foreach ($name in @('Categories', 'Lists', 'Selections', 'Read me')) {
    $sheet = $originalWorkbook.SelectSingleNode("//m:sheet[@name='$name']", $wbNs)
    if (-not $sheet) { throw "Missing original sheet: $name" }
    $rid = $sheet.GetAttribute('id', $relNs)
    $target = 'xl/' + $relById[$rid].TrimStart('/')
    $originalHashes[$target] = Hash-Bytes (Read-ZipEntryBytes $readZip $target)
  }
} finally { $readZip.Dispose() }

$tempPath = Join-Path ([IO.Path]::GetTempPath()) ('tes-default-order-' + [Guid]::NewGuid().ToString('N') + '.xlsx')
Copy-Item -LiteralPath $workbookPath -Destination $tempPath
try {
  $zip = [IO.Compression.ZipFile]::Open($tempPath, [IO.Compression.ZipArchiveMode]::Update)
  try {
    [xml]$workbook = Read-ZipEntryText $zip 'xl/workbook.xml'
    [xml]$relationships = Read-ZipEntryText $zip 'xl/_rels/workbook.xml.rels'
    [xml]$contentTypes = Read-ZipEntryText $zip '[Content_Types].xml'

    $workbookNs = [Xml.XmlNamespaceManager]::new($workbook.NameTable)
    $workbookNs.AddNamespace('m', $mainNs)
    $workbookNs.AddNamespace('r', $relNs)
    $relationshipNs = [Xml.XmlNamespaceManager]::new($relationships.NameTable)
    $relationshipNs.AddNamespace('p', $packageRelNs)
    $typesNs = [Xml.XmlNamespaceManager]::new($contentTypes.NameTable)
    $typesNs.AddNamespace('t', $contentTypeNs)

    # Reruns replace only this generated sheet.
    $oldSheet = $workbook.SelectSingleNode("//m:sheet[@name='Default order']", $workbookNs)
    if ($oldSheet) {
      $oldRid = $oldSheet.GetAttribute('id', $relNs)
      $oldRel = $relationships.SelectSingleNode("//p:Relationship[@Id='$oldRid']", $relationshipNs)
      if ($oldRel) {
        $oldTarget = 'xl/' + $oldRel.Target.TrimStart('/')
        $oldEntry = $zip.GetEntry($oldTarget)
        if ($oldEntry) { $oldEntry.Delete() }
        [void]$oldRel.ParentNode.RemoveChild($oldRel)
      }
      [void]$oldSheet.ParentNode.RemoveChild($oldSheet)
    }
    foreach ($oldType in @($contentTypes.SelectNodes("//t:Override[starts-with(@PartName, '/xl/worksheets/sheet')]", $typesNs))) {
      if ($oldType.PartName -match '/sheet(\d+)\.xml$' -and -not $zip.GetEntry($oldType.PartName.TrimStart('/'))) {
        [void]$oldType.ParentNode.RemoveChild($oldType)
      }
    }

    $sheetNumbers = @($zip.Entries | Where-Object FullName -match '^xl/worksheets/sheet\d+\.xml$' |
      ForEach-Object { [int]([regex]::Match($_.FullName, 'sheet(\d+)').Groups[1].Value) })
    $sheetNumber = (($sheetNumbers | Measure-Object -Maximum).Maximum) + 1
    $sheetPart = "xl/worksheets/sheet$sheetNumber.xml"
    $sheetTarget = "worksheets/sheet$sheetNumber.xml"
    $sheetIds = @($workbook.SelectNodes('//m:sheets/m:sheet', $workbookNs) | ForEach-Object { [int]$_.sheetId })
    $sheetId = (($sheetIds | Measure-Object -Maximum).Maximum) + 1
    $usedRid = @($relationships.SelectNodes('//p:Relationship', $relationshipNs) | ForEach-Object {
      if ($_.Id -match '^rId(\d+)$') { [int]$Matches[1] }
    })
    $rid = 'rId' + ((($usedRid | Measure-Object -Maximum).Maximum) + 1)

    $sheetNode = $workbook.CreateElement('sheet', $mainNs)
    $sheetNode.SetAttribute('name', 'Default order')
    $sheetNode.SetAttribute('sheetId', [string]$sheetId)
    [void]$sheetNode.SetAttribute('id', $relNs, $rid)
    [void]$workbook.SelectSingleNode('//m:sheets', $workbookNs).AppendChild($sheetNode)

    $relNode = $relationships.CreateElement('Relationship', $packageRelNs)
    $relNode.SetAttribute('Id', $rid)
    $relNode.SetAttribute('Type', $worksheetRelType)
    $relNode.SetAttribute('Target', $sheetTarget)
    [void]$relationships.DocumentElement.AppendChild($relNode)

    $override = $contentTypes.CreateElement('Override', $contentTypeNs)
    $override.SetAttribute('PartName', '/' + $sheetPart)
    $override.SetAttribute('ContentType', $worksheetContentType)
    [void]$contentTypes.DocumentElement.AppendChild($override)

    $headers = @('Rank', 'Prefix', 'Course', 'Group', 'Group name', 'Score', 'Duration (days)', 'Score/day', 'Contributions')
    $sheetRows = [Text.StringBuilder]::new()
    $note = 'Scoring view only: prerequisites are ignored here. The real queue uses these scores, but prerequisite readiness can reorder courses.'
    [void]$sheetRows.Append('<row r="1" ht="28" customHeight="1">' + (Text-Cell 'A1' $note 2) + '</row>')
    [void]$sheetRows.Append('<row r="2" ht="30" customHeight="1">')
    for ($col = 1; $col -le $headers.Count; $col++) {
      [void]$sheetRows.Append((Text-Cell ((Excel-Column $col) + '2') $headers[$col - 1] 1))
    }
    [void]$sheetRows.Append('</row>')

    for ($i = 0; $i -lt $data.rows.Count; $i++) {
      $item = $data.rows[$i]
      $rowNumber = $i + 3
      $style = if (($i % 2) -eq 0) { 3 } else { 4 }
      [void]$sheetRows.Append('<row r="' + $rowNumber + '">')
      [void]$sheetRows.Append((Number-Cell "A$rowNumber" ([double]$item.rank) $style))
      [void]$sheetRows.Append((Text-Cell "B$rowNumber" $item.prefix $style))
      [void]$sheetRows.Append((Text-Cell "C$rowNumber" $item.course $style))
      [void]$sheetRows.Append((Number-Cell "D$rowNumber" ([double]$item.group) $style))
      [void]$sheetRows.Append((Text-Cell "E$rowNumber" $item.groupName $style))
      [void]$sheetRows.Append((Number-Cell "F$rowNumber" ([double]$item.score) $style))
      [void]$sheetRows.Append((Number-Cell "G$rowNumber" ([double]$item.durationDays) $style))
      [void]$sheetRows.Append((Number-Cell "H$rowNumber" ([double]$item.scorePerDay) $style))
      [void]$sheetRows.Append((Text-Cell "I$rowNumber" $item.contributions $style))
      [void]$sheetRows.Append('</row>')
    }

    $lastRow = $data.rows.Count + 2
    $worksheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="' + $mainNs + '" xmlns:r="' + $relNs + '">' +
      '<dimension ref="A1:I' + $lastRow + '"/>' +
      '<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A3" sqref="A3"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' +
      '<col min="1" max="1" width="8" customWidth="1"/><col min="2" max="2" width="13" customWidth="1"/>' +
      '<col min="3" max="3" width="38" customWidth="1"/><col min="4" max="4" width="8" customWidth="1"/>' +
      '<col min="5" max="5" width="24" customWidth="1"/><col min="6" max="6" width="20" customWidth="1"/>' +
      '<col min="7" max="7" width="16" customWidth="1"/><col min="8" max="8" width="20" customWidth="1"/>' +
      '<col min="9" max="9" width="86" customWidth="1"/></cols>' +
      '<sheetData>' + $sheetRows.ToString() + '</sheetData>' +
      '<autoFilter ref="A2:I' + $lastRow + '"/><mergeCells count="1"><mergeCell ref="A1:I1"/></mergeCells>' +
      '</worksheet>'

    Write-ZipEntryText $zip 'xl/workbook.xml' (Xml-ToString $workbook)
    Write-ZipEntryText $zip 'xl/_rels/workbook.xml.rels' (Xml-ToString $relationships)
    Write-ZipEntryText $zip '[Content_Types].xml' (Xml-ToString $contentTypes)
    Write-ZipEntryText $zip $sheetPart $worksheetXml
  } finally { $zip.Dispose() }

  # Structural QA and the promised byte-level preservation check.
  $verifyZip = [IO.Compression.ZipFile]::OpenRead($tempPath)
  try {
    foreach ($part in $originalHashes.Keys) {
      $after = Hash-Bytes (Read-ZipEntryBytes $verifyZip $part)
      if ($after -ne $originalHashes[$part]) { throw "Original worksheet bytes changed: $part" }
    }
    [xml]$verifyWorkbook = Read-ZipEntryText $verifyZip 'xl/workbook.xml'
    $verifyNs = [Xml.XmlNamespaceManager]::new($verifyWorkbook.NameTable)
    $verifyNs.AddNamespace('m', $mainNs)
    $names = @($verifyWorkbook.SelectNodes('//m:sheets/m:sheet', $verifyNs) | ForEach-Object name)
    if (($names -join '|') -ne 'Categories|Lists|Selections|Read me|Default order') {
      throw "Unexpected sheet order: $($names -join ', ')"
    }
    [xml]$verifySheet = Read-ZipEntryText $verifyZip $sheetPart
    $sheetNs = [Xml.XmlNamespaceManager]::new($verifySheet.NameTable)
    $sheetNs.AddNamespace('m', $mainNs)
    $rowsWritten = $verifySheet.SelectNodes('//m:sheetData/m:row', $sheetNs).Count
    if ($rowsWritten -ne 133) { throw "Expected 133 written rows, got $rowsWritten" }
    $pane = $verifySheet.SelectSingleNode('//m:pane', $sheetNs)
    if (-not $pane -or $pane.state -ne 'frozen' -or $pane.ySplit -ne '2') {
      throw 'Default order header rows are not frozen'
    }
  } finally { $verifyZip.Dispose() }

  Move-Item -LiteralPath $tempPath -Destination $workbookPath -Force
} finally {
  if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
}

"Wrote Default order with $($data.rows.Count) courses; completed education working-stat base: $($data.completedWorkingStats)."
$data.rows | Select-Object -First 15 rank, prefix, course, group, groupName, score, durationDays, scorePerDay |
  Format-Table -AutoSize
