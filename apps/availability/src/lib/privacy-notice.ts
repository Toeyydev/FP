/**
 * The Privacy Notice, word for word as the FolkOPS guide app shows it
 * (folkops-guide-android: src/Screens/PrivacyNoticeScreen.tsx).
 *
 * It lives here as well so the same wording can be served at a public URL — Google
 * Play requires a privacy policy anyone can open without signing in, and every
 * page of this app sits behind the operator login.
 *
 * Keep the two copies identical, and keep NOTICE_VERSION in step with the app's
 * PRIVACY_NOTICE_VERSION: a guide's acknowledgement is stored against that string,
 * so the version must always name the wording they actually read.
 *
 * The Thai and English lists are numbered by position when rendered, so they must
 * stay in the same order.
 */

/** Matches PRIVACY_NOTICE_VERSION in the app (src/config/env.ts). */
export const NOTICE_VERSION = "2026-09-12";

export type NoticeSection = { title: string; body: string };

export const thaiSections: NoticeSection[] = [
  {
    title: "ผู้ควบคุมข้อมูลส่วนบุคคล",
    body: "บริษัท โฟล์คพาธส์ จำกัด เป็นผู้ควบคุมข้อมูลส่วนบุคคลตามประกาศฉบับนี้ และเป็นผู้กำหนดวัตถุประสงค์และวิธีการประมวลผลข้อมูลที่ท่านกรอกในแบบสมัครมัคคุเทศก์ FolkOPS ช่องทางติดต่อเพื่อสอบถามหรือใช้สิทธิของท่านอยู่ในหัวข้อ “ช่องทางติดต่อ Folkpaths” ท้ายประกาศฉบับนี้",
  },
  {
    title: "ข้อมูลที่เราเก็บรวบรวม",
    body: "เราเก็บข้อมูลระบุตัวตน ได้แก่ ชื่อ–นามสกุลภาษาไทยและภาษาอังกฤษ และเลขประจำตัวประชาชน ข้อมูลติดต่อ ได้แก่ หมายเลขโทรศัพท์และอีเมล ข้อมูลใบอนุญาต ได้แก่ เลขที่ใบอนุญาตมัคคุเทศก์และวันหมดอายุ ข้อมูลบัญชีธนาคาร ได้แก่ ชื่อธนาคาร ชื่อเจ้าของบัญชี และเลขบัญชี เอกสารแนบสามรายการ ได้แก่ รูปบัตรประชาชน รูปใบอนุญาตมัคคุเทศก์ และหลักฐานบัญชีธนาคาร รหัสผ่านที่ท่านตั้งไว้สำหรับเข้าสู่ระบบ ข้อมูลผู้ติดต่อกรณีฉุกเฉิน ได้แก่ ชื่อ หมายเลขโทรศัพท์ และความสัมพันธ์หากท่านระบุไว้ ภาษาที่ท่านเลือกใช้งาน และบันทึกการรับทราบประกาศฉบับนี้ ซึ่งประกอบด้วยเวอร์ชันของประกาศและวันเวลาที่ท่านกดยืนยัน นอกจากนี้เราเก็บข้อมูลสุขภาพตามที่อธิบายในหัวข้อ “ข้อมูลสุขภาพและข้อมูลติดต่อฉุกเฉิน”",
  },
  {
    title: "ข้อมูลที่เก็บระหว่างปฏิบัติงานผ่านแอป FolkOPS",
    body: "เมื่อท่านใช้แอป FolkOPS ระหว่างปฏิบัติงาน เราเก็บข้อมูลเพิ่มเติมดังนี้ (๑) ตำแหน่งที่ตั้งของอุปกรณ์ เฉพาะขณะที่ท่านกดปุ่มเช็กอิน เริ่มทัวร์ หรือจบทัวร์ โดยบันทึกพิกัดละติจูด–ลองจิจูด ความแม่นยำ และระยะห่างจากจุดนัดพบที่คำนวณได้ เพื่อยืนยันว่าท่านอยู่ ณ จุดนัดพบตามเวลาที่กำหนด แอปไม่ติดตามตำแหน่งของท่านอย่างต่อเนื่อง ไม่อ่านตำแหน่งขณะทำงานเบื้องหลัง และหากท่านไม่อนุญาตให้เข้าถึงตำแหน่ง ท่านยังเช็กอินได้ตามปกติ เพียงแต่จะไม่มีข้อมูลยืนยันตำแหน่งแนบไปด้วย (๒) บันทึกการปฏิบัติงาน ได้แก่ เวลาเช็กอิน เริ่มและจบทัวร์ จำนวนผู้เดินทางที่มาจริงและที่ไม่มา รายงานหลังจบทัวร์ และหมายเหตุที่ท่านกรอก (๓) รายการค่าใช้จ่ายที่ท่านรายงาน และการรับ–คืนเงินทดรองจ่าย รวมถึงรูปสลิปการโอนที่ท่านแนบ ส่วนการแจ้งเตือนก่อนวันทัวร์นั้น แอปตั้งเวลาไว้ในเครื่องของท่านเองจากตารางงานของท่าน โดยไม่มีการส่งข้อมูลออกจากเครื่องเพื่อการนี้",
  },
  {
    title: "วัตถุประสงค์",
    body: "เราใช้ข้อมูลเพื่อยืนยันตัวตน ตรวจสอบคุณสมบัติและใบอนุญาต พิจารณาใบสมัคร ติดต่อผู้สมัคร จัดทำสัญญา บริหารการปฏิบัติงาน จ่ายค่าตอบแทน ปฏิบัติตามกฎหมาย รักษาความปลอดภัย และป้องกันการทุจริต ส่วนข้อมูลสุขภาพ เราใช้เพื่อช่วยเหลือท่านในกรณีฉุกเฉินระหว่างปฏิบัติงานเท่านั้น และไม่ใช้เพื่อคัดกรองหรือประเมินผลงานของท่าน",
  },
  {
    title: "ฐานกฎหมาย",
    body: "เราประมวลผลข้อมูลเพื่อดำเนินการตามคำขอของผู้สมัครก่อนเข้าทำสัญญา เพื่อปฏิบัติตามสัญญา เพื่อปฏิบัติตามหน้าที่ตามกฎหมาย และเพื่อประโยชน์โดยชอบด้วยกฎหมายของบริษัท สำหรับข้อมูลสุขภาพซึ่งเป็นข้อมูลอ่อนไหวตามมาตรา 26 แห่ง พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล เราประมวลผลโดยอาศัยความยินยอมโดยชัดแจ้งที่ท่านให้ไว้ในขั้นตอนสุดท้ายของการสมัคร และเพื่อป้องกันหรือระงับอันตรายต่อชีวิต ร่างกาย หรือสุขภาพของท่าน",
  },
  {
    title: "ความจำเป็นในการให้ข้อมูล",
    body: "ข้อมูลในแบบสมัครเป็นข้อมูลที่จำเป็นต่อการตรวจสอบและพิจารณาใบสมัคร หากท่านไม่ให้ข้อมูลที่จำเป็น Folkpaths อาจไม่สามารถดำเนินการสมัครหรืออนุมัติบัญชีได้",
  },
  {
    title: "ข้อมูลสุขภาพและข้อมูลติดต่อฉุกเฉิน",
    body: "Folkpaths เก็บข้อมูลเกี่ยวกับโรคประจำตัวและข้อมูลผู้ติดต่อฉุกเฉิน เท่าที่จำเป็น เพื่อเตรียมความพร้อมและให้ความช่วยเหลือเมื่อเกิดเหตุฉุกเฉินระหว่างการปฏิบัติงาน ข้อมูลดังกล่าวจะเข้าถึงได้เฉพาะ Operator หรือผู้ดูแลระบบที่ได้รับอนุญาต และจะไม่แสดงในรายการผู้สมัครทั่วไป การเปิดเผยต่อบุคคลภายนอกจะทำเฉพาะเมื่อจำเป็นต่อการช่วยเหลือฉุกเฉิน การรักษาพยาบาล หรือเมื่อกฎหมายกำหนด หากท่านให้ข้อมูลผู้ติดต่อฉุกเฉินของบุคคลอื่น กรุณาแจ้งบุคคลนั้นว่าท่านได้ให้ชื่อและหมายเลขโทรศัพท์ไว้กับ Folkpaths เพื่อวัตถุประสงค์นี้ และเราจะติดต่อบุคคลดังกล่าวเฉพาะเมื่อเกิดเหตุฉุกเฉินเท่านั้น",
  },
  {
    title: "ผู้ที่สามารถเข้าถึงข้อมูล",
    body: "ภายใน Folkpaths ข้อมูลของท่านเข้าถึงได้เฉพาะ Operator และผู้ดูแลระบบที่ได้รับมอบหมายให้ตรวจสอบใบสมัครและบริหารการปฏิบัติงาน เราจำกัดสิทธิการเข้าถึงตามหน้าที่ที่รับผิดชอบ ข้อมูลสุขภาพจะไม่แสดงในรายการใบสมัครที่รออนุมัติ และจะปรากฏต่อผู้มีสิทธิเมื่อเปิดรายละเอียดใบสมัครรายบุคคลเท่านั้น",
  },
  {
    title: "การเปิดเผยข้อมูล",
    body: "เราอาจเปิดเผยข้อมูลเท่าที่จำเป็นแก่ Operator ที่ได้รับมอบหมาย ผู้ให้บริการระบบ Cloud และฐานข้อมูล ผู้ให้บริการจัดเก็บไฟล์ ธนาคาร ผู้ให้บริการบัญชี ที่ปรึกษาวิชาชีพ และหน่วยงานรัฐที่มีอำนาจตามกฎหมาย สำหรับข้อมูลสุขภาพ เราจะเปิดเผยต่อบุคคลภายนอกเฉพาะเมื่อจำเป็นต่อการช่วยเหลือฉุกเฉิน การรักษาพยาบาล หรือเมื่อกฎหมายกำหนดเท่านั้น",
  },
  {
    title: "การส่งข้อมูลไปต่างประเทศ",
    body: "ผู้ให้บริการระบบบางรายอาจจัดเก็บหรือประมวลผลข้อมูลนอกประเทศไทย เราจะใช้มาตรการและข้อตกลงที่เหมาะสมเพื่อคุ้มครองข้อมูลตามกฎหมาย",
  },
  {
    title: "ระยะเวลาเก็บรักษา",
    body: "เราจะเก็บข้อมูลเท่าที่จำเป็นต่อการพิจารณาใบสมัคร การปฏิบัติงาน การจ่ายค่าตอบแทน การจัดทำบัญชีและภาษี และการจัดการข้อพิพาท ข้อมูลสุขภาพจะเก็บไว้เพียงเท่าที่ท่านยังปฏิบัติงานกับ Folkpaths หรือจนกว่าท่านจะถอนความยินยอม แล้วแต่ระยะเวลาใดสิ้นสุดก่อน เมื่อหมดความจำเป็น เราจะลบ ทำลาย หรือทำให้ข้อมูลไม่สามารถระบุตัวบุคคลได้",
  },
  {
    title: "การรักษาความปลอดภัย",
    body: "เราใช้มาตรการรักษาความปลอดภัยที่เหมาะสม จำกัดสิทธิการเข้าถึงเฉพาะผู้ที่จำเป็น และเก็บเอกสารใบอนุญาตกับหลักฐานบัญชีในพื้นที่ที่ไม่เปิดเผยต่อสาธารณะ ข้อมูลสุขภาพจะถูกเข้ารหัสก่อนจัดเก็บ ไม่แสดงในรายการใบสมัครที่รออนุมัติ และจะปรากฏต่อ Operator เมื่อเปิดรายละเอียดใบสมัครนั้นเท่านั้น",
  },
  {
    title: "สิทธิของเจ้าของข้อมูล",
    body: "ภายใต้เงื่อนไขของกฎหมาย ท่านอาจขอเข้าถึง ขอสำเนา ขอแก้ไข ขอให้ลบ ขอระงับการใช้ คัดค้าน ขอรับหรือโอนย้ายข้อมูล ถอนความยินยอมในกรณีที่ใช้ฐานความยินยอม และร้องเรียนต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคล การถอนความยินยอมสำหรับข้อมูลสุขภาพไม่กระทบต่อการประมวลผลที่ได้ทำไปแล้วก่อนการถอน แต่อาจทำให้ Folkpaths ไม่สามารถเตรียมความช่วยเหลือเฉพาะบุคคลให้ท่านได้เมื่อเกิดเหตุฉุกเฉิน",
  },
  {
    title: "ช่องทางติดต่อ Folkpaths",
    body: "หากท่านมีคำถามเกี่ยวกับประกาศฉบับนี้ ต้องการใช้สิทธิของเจ้าของข้อมูลส่วนบุคคล ต้องการแก้ไขหรือลบข้อมูลสุขภาพที่ให้ไว้ หรือต้องการถอนความยินยอม กรุณาติดต่อ บริษัท โฟล์คพาธส์ จำกัด ทางอีเมล admin@folkpaths.com เราจะดำเนินการตามคำขอของท่านภายในระยะเวลาที่กฎหมายกำหนด",
  },
  {
    title: "การพิจารณาใบสมัคร",
    body: "การส่งใบสมัครไม่ได้หมายความว่าท่านได้รับอนุมัติเป็นมัคคุเทศก์ของ Folkpaths โดยอัตโนมัติ บริษัทจะตรวจสอบข้อมูลและแจ้งผลให้ท่านทราบผ่านช่องทางติดต่อที่ให้ไว้",
  },
  {
    title: "เวอร์ชันของประกาศและการเปลี่ยนแปลง",
    body: `ประกาศฉบับนี้คือเวอร์ชัน ${NOTICE_VERSION} ระบบจะบันทึกเวอร์ชันนี้ไว้พร้อมกับวันเวลาที่ท่านกดยืนยัน เพื่อให้การรับทราบของท่านผูกกับข้อความที่ท่านได้อ่านจริง เราอาจปรับปรุงประกาศตามการเปลี่ยนแปลงของบริการ เทคโนโลยี หรือกฎหมาย และจะแจ้งการเปลี่ยนแปลงที่สำคัญผ่านช่องทางที่เหมาะสม`,
  },
];

export const englishSections: NoticeSection[] = [
  {
    title: "Data controller",
    body: "Folkpaths Co., Ltd. is the data controller under this Notice and determines the purposes and means of processing the information you enter in the FolkOPS guide application. Contact details for questions or to exercise your rights are in the “How to contact Folkpaths” section at the end of this Notice.",
  },
  {
    title: "Personal data we collect",
    body: "We collect identity data, being your Thai and English name and Thai National ID number; contact data, being your telephone number and email address; licence data, being your guide licence number and expiry date; bank account data, being the bank name, account holder name and account number; three attached documents, being your ID card image, guide licence image and bank account evidence; the password you set for signing in; the name and phone number of your emergency contact and, if you give it, their relationship to you; your chosen interface language; and a record of your acknowledgement of this Notice, consisting of the Notice version and the date and time you confirmed it. We also collect health information as described in “Health and emergency contact information”.",
  },
  {
    title: "Information collected while you work in the FolkOPS app",
    body: "When you use the FolkOPS app on a tour, we collect the following in addition to the above. (1) Your device's location, only at the moment you press check in, start tour or complete tour: the latitude and longitude, its accuracy, and the distance calculated from the meeting point, so that your presence at the meeting point at the appointed time can be confirmed. The app does not track your location continuously, does not read it in the background, and if you do not grant location access you can still check in — the record simply carries no location. (2) Your work record: the times you checked in, started and completed each tour, how many guests arrived and how many did not, your end-of-tour report, and any notes you write. (3) The expenses you report, and money advanced to you and returned by you, including any transfer slip you attach. The reminder you receive the evening before a tour is scheduled on your own device from your own schedule; nothing leaves your phone for it.",
  },
  {
    title: "Purposes of processing",
    body: "We use your data to verify your identity and qualifications, review your application, contact you, prepare contractual arrangements, manage guide operations, make payments, comply with legal obligations, maintain security and prevent fraud. Health information is used only to assist you during a work-related emergency, and never to screen applicants or assess your performance.",
  },
  {
    title: "Legal bases",
    body: "We process personal data to take steps at your request before entering into a contract, perform a contract, comply with legal obligations and pursue our legitimate interests where permitted by law. Health information is sensitive personal data under section 26 of the Personal Data Protection Act; we process it on the explicit consent you give in the final step of the application, and to prevent or suppress a danger to your life, body or health.",
  },
  {
    title: "Required information",
    body: "The information requested in the application is necessary for verification and application review. If you do not provide required information, Folkpaths may be unable to process your application or approve your account.",
  },
  {
    title: "Health and emergency contact information",
    body: "Folkpaths collects information about medical conditions and emergency contacts only to the extent necessary to prepare for and provide assistance during a work-related emergency. Access is restricted to authorised Operators or Administrators and the information is not displayed in the general applicant list. Disclosure to third parties will occur only when necessary for emergency assistance, medical treatment, or where required by law. If you name another person as your emergency contact, please tell them that you have given their name and phone number to Folkpaths for this purpose; we will contact them only in an emergency.",
  },
  {
    title: "Who can access your information",
    body: "Within Folkpaths, your information is accessible only to Operators and Administrators assigned to review applications and manage guide operations, and access is limited to what each role requires. Health information is not shown in the list of pending applications and becomes visible to an authorised person only when they open that individual application.",
  },
  {
    title: "Disclosure of information",
    body: "We may disclose necessary information to authorised operators, cloud and database providers, file-storage providers, banks, accounting providers, professional advisers and legally authorised government agencies. Health information is disclosed to third parties only where necessary for emergency assistance, medical treatment, or where required by law.",
  },
  {
    title: "International transfers",
    body: "Some service providers may store or process information outside Thailand. We will apply appropriate safeguards and contractual measures as required by applicable law.",
  },
  {
    title: "Retention",
    body: "We retain information only as long as necessary for application review, guide operations, payment, accounting, tax and dispute management. Health information is kept only while you continue to work with Folkpaths, or until you withdraw your consent, whichever comes first. When no longer required, the information will be deleted, destroyed or anonymised.",
  },
  {
    title: "Security",
    body: "We apply appropriate security measures, restrict access to authorised personnel and keep guide-license and bank-account evidence in non-public storage. Health information is encrypted before storage, is not shown in the list of pending applications, and is visible to an operator only when they open that individual application.",
  },
  {
    title: "Your rights",
    body: "Subject to applicable law, you may request access, a copy, correction, deletion, restriction, objection or data portability, withdraw consent where consent is used, and lodge a complaint with the Personal Data Protection Committee. Withdrawing consent for health information does not affect processing carried out before the withdrawal, but it may leave Folkpaths unable to prepare assistance tailored to you in an emergency.",
  },
  {
    title: "How to contact Folkpaths",
    body: "If you have a question about this Notice, wish to exercise your rights, want the health information you provided corrected or deleted, or want to withdraw your consent, contact Folkpaths Co., Ltd. at admin@folkpaths.com. We will respond to your request within the period required by law.",
  },
  {
    title: "Application review",
    body: "Submitting an application does not automatically approve you as a Folkpaths guide. Folkpaths will review your information and notify you through the contact details provided.",
  },
  {
    title: "Notice version and changes",
    body: `This is version ${NOTICE_VERSION} of the Notice. The system records this version alongside the date and time you confirm it, so that your acknowledgement stays tied to the wording you actually read. We may update this Notice when our services, technology or legal requirements change, and material changes will be communicated through an appropriate channel.`,
  },
];
