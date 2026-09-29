import { afterEach,describe,expect,it,vi } from "vitest";
import { syncAdvanceBatch } from "./peak-sync";
import type { PrismaClient } from "@prisma/client";
const config = {advanceAccountCode:"115101",bankAccountCode:"111301",bankAccountSubId:"bank",journalTypeIds:{ADVANCE:"3",RETURN:"2",EXPENSE:"1"}};
function fixture() {
 vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC","1");vi.stubEnv("ADVANCE_WRITES_FROZEN","0");vi.stubEnv("PEAK_ADVANCE_CONFIG",JSON.stringify(config));
 const row:any={id:"ADVANCE:a",kind:"ADVANCE",sourceId:"a",status:"PENDING",updatedAt:new Date(),attempts:0};
 const outbox={findMany:vi.fn(async()=>["PENDING","BLOCKED"].includes(row.status)?[{...row}]:[]),updateMany:vi.fn(async({where,data}:any)=>{
  if(!where.id)return {count:0}; if(row.status!==where.status)return {count:0};Object.assign(row,data);return {count:1};
 }),update:vi.fn(async({data}:any)=>{Object.assign(row,data);return row;})};
 const db:any={advancePeakSync:outbox,peakAccountMapping:{findMany:async()=>[]},guideAdvance:{findUniqueOrThrow:async()=>({id:"a",guideId:"g",jobNo:"J-1",advanceNo:"A-1",advanceDate:"2026-09-23",amountSatang:100000,method:"bank",bankAccount:"bank",txRef:"tx",slipUrl:"https://drive.google.com/slip"}),count:async()=>1,update:vi.fn()},user:{findUnique:async()=>({peakContactId:"contact"})}};
 db.$transaction=async(fn:any)=>fn(db);
 return {db:db as PrismaClient,row};
}
afterEach(()=>vi.unstubAllEnvs());
describe("durable advance sender",()=>{
 it("posts once, saves the document, skips it on the next poll",async()=>{const {db,row}=fixture();const post=vi.fn().mockResolvedValue({ok:true,id:"doc",code:"JV-1"});expect(await syncAdvanceBatch(db,post)).toBe(1);await syncAdvanceBatch(db,post);expect(post).toHaveBeenCalledTimes(1);expect(row).toMatchObject({status:"POSTED",documentNo:"JV-1"});});
 it("stops an ambiguous response rather than automatically repeating a transfer",async()=>{const {db,row}=fixture();const post=vi.fn().mockResolvedValue({ok:false,uncertain:true,desc:"timeout"});await syncAdvanceBatch(db,post);await syncAdvanceBatch(db,post);expect(row.status).toBe("UNCERTAIN");expect(post).toHaveBeenCalledTimes(1);});
 it("a network throw stops automatic retries",async()=>{const {db,row}=fixture();const post=vi.fn().mockRejectedValue(new Error("disconnected"));await syncAdvanceBatch(db,post);await syncAdvanceBatch(db,post);expect(row.status).toBe("UNCERTAIN");expect(post).toHaveBeenCalledTimes(1);});
 it("blocks missing contact before a POST",async()=>{const {db,row}=fixture();vi.spyOn(db.user,"findUnique").mockResolvedValue(null);const post=vi.fn();await syncAdvanceBatch(db,post);expect(row.status).toBe("BLOCKED");expect(post).not.toHaveBeenCalled();});
 it("respects the production cutover freeze",async()=>{const {db}=fixture();vi.stubEnv("ADVANCE_WRITES_FROZEN","1");const post=vi.fn();expect(await syncAdvanceBatch(db,post)).toBe(0);expect(post).not.toHaveBeenCalled();});
 it("does nothing until enabled",async()=>{const {db}=fixture();vi.stubEnv("PEAK_ADVANCE_AUTO_SYNC","0");expect(await syncAdvanceBatch(db,vi.fn())).toBe(0);});
 it("a successful POST followed by DB failure is uncertain",async()=>{const {db,row}=fixture();vi.spyOn(db,"$transaction").mockRejectedValue(new Error("db down"));const post=vi.fn().mockResolvedValue({ok:true,id:"doc",code:"JV-1"});await syncAdvanceBatch(db,post);expect(row.status).toBe("UNCERTAIN");await syncAdvanceBatch(db,post);expect(post).toHaveBeenCalledTimes(1);});
});
