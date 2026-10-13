#!/bin/sh
# Builds tests/fixtures/libreoffice-comments.pdf: a PDF whose comments were written by another tool (LibreOffice Writer, notes exported as /Text annotations with popups)
set -e
out="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures"
work="$(mktemp -d)"
cat > "$work/libreoffice-comments.fodt" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:body><office:text>
  <text:p>The quarterly report is <office:annotation office:name="c1"><dc:creator>Dana Reviewer</dc:creator><dc:date>2026-03-04T10:30:00</dc:date><text:p>Please check these figures against the ledger.</text:p></office:annotation>ready for review<office:annotation-end office:name="c1"/> by the board.</text:p>
  <text:p>Second paragraph with <office:annotation><dc:creator>Eli Editor</dc:creator><dc:date>2026-03-05T08:00:00</dc:date><text:p>Shorter please.</text:p></office:annotation>more text.</text:p>
 </office:text></office:body>
</office:document>
XML
(cd "$work" && soffice --headless --convert-to 'pdf:writer_pdf_Export:{"ExportNotes":{"type":"boolean","value":"true"}}' libreoffice-comments.fodt >/dev/null)
cp "$work/libreoffice-comments.pdf" "$out/"
rm -rf "$work"
