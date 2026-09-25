# What Chrome's PDF viewer reads out of a PDF — the text its search and copy work on.
#
# Chrome (and so Google Drive's preview) is built on PDFium; pypdfium2 is PDFium itself,
# so this is the same text layer read by the same engine, without a person at a viewer.
# Reads a PDF on stdin; prints each page's text, pages separated by a form feed.
import sys
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument(sys.stdin.buffer.read())
pages = []
for page in pdf:
    tp = page.get_textpage()
    pages.append(tp.get_text_range())
    tp.close()
    page.close()
sys.stdout.write("\f".join(pages))
