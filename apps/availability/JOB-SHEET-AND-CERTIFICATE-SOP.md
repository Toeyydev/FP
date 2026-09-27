# SOP: Job Sheet vs. certificate in lieu of receipt

**Applies to:** operators and admins in FolkOPS (ops.folkpaths.com)
**Effective:** from the release that removes the certification block from job sheets (2026-09)

## 1. Two documents, two jobs

| | Job Sheet | ใบรับรองแทนใบเสร็จรับเงิน (certificate in lieu of receipt) |
|---|---|---|
| What it is | The operating record of one tour, and the **approval of its expenses** | A **separate accounting document** that stands in for receipts nobody issues (ferry, bus, street-vendor water) |
| Number | `FOLK-BKK-YYYYMMDD-NN` | `CERT-FOLK-BKK-YYYYMMDD-NN-NN` (e.g. `CERT-FOLK-BKK-20990101-01-01`) |
| Who can see it | Operators, admins, and the guide (their own) | **Admins only** |
| Signed? | **No.** It shows approval status, the approver and the approval time | Yes. It is attested by an authorised admin, with that admin's registered signature |
| Where the file lives | The job sheet's Google Doc / PDF | Its own PDF in Drive, linked to the rows it covers |

The job sheet **no longer** carries:
- the statement "ข้าพเจ้าขอรับรองว่ารายการค่าใช้จ่าย…"
- the **CERTIFIED BY** heading
- a signature image
- a certifier name, or a date under a signature

The approval block (**Approval · การอนุมัติค่าใช้จ่าย**: status, approver, date and time) is **not** a signature on a certificate.

## 2. Operator: close out a job sheet

1. Open the job sheet from Dispatch / Tour Log.
2. Check the guests, the expenses (count × price) and **Paid By** on every row that has an amount.
3. Press **Save**. The first save gives the sheet its job number.
4. Press **Approve** when the figures are final. The sheet now shows:
   - **สถานะ: อนุมัติแล้ว**
   - **ผู้อนุมัติ**: your name
   - **วันเวลาที่อนุมัติ** (Bangkok time)
5. Print or save the PDF if you need it. The PDF shows the same approval block and nothing else about signing.

Unapproving clears the approver and time from the sheet. The audit log keeps the history.

## 3. Admin: the certificate, if the job needs one

A certificate is needed only for **the guide's own money, with an amount, and no receipt** (Paid By = ไกด์จ่ายเอง).

1. On the job sheet (admin view), the box **ใบรับรองแทนใบเสร็จรับเงิน** says one of:
   - **the certificate number and status**, with **เปิดไฟล์ใน Drive** once it is filed. Nothing to do unless it is not yet LINKED.
   - **ยังไม่มีใบรับรอง — N รายการ…**: a certificate is needed. Go to step 2.
   - **ไม่มีรายการที่ต้องใช้**: nothing on the sheet needs one.
2. In the **ใบรับรองแทนใบเสร็จรับเงิน** panel above it, follow the existing steps in order:
   1. **สร้างร่าง** (draft: choose where the rows came from, either guide-reported or admin-recorded)
   2. **รับรอง** (attest)
   3. **จัดเก็บใน Drive**
   4. **link** the certificate to the rows
3. Nothing is created automatically. Every step is a person pressing a button, and every step is audited.
4. To replace a certificate, withdraw it (with a reason) first, then issue a new one. The old number stays in the history as **ยกเลิกแล้ว**.

For jobs before 26 Sep 2026, use **/admin/historical-evidence** to work through them. It prepares drafts only; attest, file and link on the job sheet as above.

## 4. What did not change

- Job sheet approval: who can approve, what it records, and its audit log.
- The approval fields in the database, and the stored first-save date (`certifiedAt`).
- Stored signatures: the admin signature registered for certificates, and the old fixed image file (no longer printed on job sheets).
- Every certificate already issued: its number, PDF, Drive file, history, withdrawal and reissue.
- PDFs and Google Docs made before this change. They are not regenerated and still show the old block.
- Payments, PEAK and every amount.

## 5. Quick answers

- **Does the approved job sheet replace a receipt?** No. For the guide's own unreceipted money, the certificate does that.
- **Why can't an operator see the certificate number?** Certificates, their files and their signer are admin-only by design. Operators see approval only.
- **The old PDF has a signature, the new one doesn't. Which is right?** Both are correct for their date. From this release, the signature belongs only on the certificate.
