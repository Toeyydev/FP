import { describe,it,expect } from "vitest";
import { advanceJournal, type AdvancePeakConfig, type JournalSource } from "./peak-journal";
import { dailyJournalResult } from "../peak-api";
const config: AdvancePeakConfig = { advanceAccountCode:"115101", bankAccountCode:"111301", bankAccountSubId:"bank-id", journalTypeIds:{ADVANCE:"pay",RETURN:"receive",EXPENSE:"general"}, expenseAccounts:{entrance:"510104"} };
const source: JournalSource = {kind:"ADVANCE",amountSatang:100000,date:"2026-09-23",guideContactId:"guide-id",reference:"ADV-1",jobNo:"JOB-1",slipUrl:"https://drive.google.com/slip"};
describe("advance journal money direction",()=>{
 it("issues an asset against the chosen bank subaccount",()=>{ const p=advanceJournal(source,config);expect(p.journalEntries).toEqual([{accountCode:"115101",debit:"1000.00",credit:"0.00"},{accountCode:"111301",debit:"0.00",credit:"1000.00",accountSubId:"bank-id"}]);expect(p.description).toContain("JOB-1"); });
 it("a return reduces the asset, never revenue",()=>{const p=advanceJournal({...source,kind:"RETURN",amountSatang:30000},config);expect(p.journalEntries[0].debit).toBe("300.00");expect(p.journalEntries[1].credit).toBe("300.00");});
 it("settles ticket costs without another bank payment",()=>{const p=advanceJournal({...source,kind:"EXPENSE",amountSatang:70000,expenses:[{description:"Ticket",amount:700,category:"entrance"}]},config);expect(p.journalEntries.map(x=>x.accountCode)).toEqual(["510104","115101"]);});
 it("keeps satang exact and preserves an explicit expense account",()=>{const p=advanceJournal({...source,kind:"EXPENSE",amountSatang:189760,expenses:[{description:"Ticket",amount:1897.60,category:"entrance",peakAccountCode:"510105"}]},config);expect(p.journalEntries[0].debit).toBe("1897.60");expect(p.journalEntries[0].accountCode).toBe("510105");});
 it("blocks partial settlement without line allocation",()=>{expect(()=>advanceJournal({...source,kind:"EXPENSE",expenses:[{description:"Ticket",amount:700,category:"entrance"}]},config)).toThrow("Partial");});
 it.each(["jobNo","guideContactId","slipUrl"] as const)("requires %s",field=>expect(()=>advanceJournal({...source,[field]:""},config)).toThrow());
 it("refuses a payable in place of an advance asset",()=>expect(()=>advanceJournal(source,{...config,advanceAccountCode:"212203"})).toThrow("asset"));
 it("requires the bank subaccount, not just the GL code",()=>expect(()=>advanceJournal(source,{...config,bankAccountSubId:""})).toThrow());
 it("rejects impossible dates",()=>expect(()=>advanceJournal({...source,date:"2026-02-30"},config)).toThrow());
 it("blocks non-ticket categories",()=>expect(()=>advanceJournal({...source,kind:"EXPENSE",expenses:[{description:"Other cost",amount:1000,category:"other"}]},config)).toThrow("ticket expenses only"));
 it("refuses non-ticket costs even when an account mapping exists",()=>expect(()=>advanceJournal({...source,kind:"EXPENSE",expenses:[{description:"Coach",amount:1000,category:"transport"}]},{...config,expenseAccounts:{...config.expenseAccounts,transport:"510104"}})).toThrow("ticket expenses only"));
});
describe("PEAK journal acknowledgements",()=>{
 it("requires a successful row AND envelope",()=>{expect(dailyJournalResult(200,{PeakDailyJournals:{resCode:"200",dailyJournals:[{resCode:"200",id:"id",code:"JV-1"}]}})).toMatchObject({ok:true,id:"id",code:"JV-1"});});
 it("an empty HTTP 200 is uncertain, never safe to resend",()=>expect(dailyJournalResult(200,{})).toMatchObject({ok:false,uncertain:true}));
 it("a row refusal inside a successful envelope is a refusal",()=>expect(dailyJournalResult(200,{PeakDailyJournals:{resCode:"200",dailyJournals:[{resCode:"400",resDesc:"invalid"}]}})).toMatchObject({ok:false,uncertain:false}));
 it("a gateway failure is uncertain",()=>expect(dailyJournalResult(502,{})).toMatchObject({ok:false,uncertain:true}));
 it("a code alone is not success",()=>expect(dailyJournalResult(200,{PeakDailyJournals:{resCode:"200",dailyJournals:[{code:"JV-1"}]}})).toMatchObject({ok:false,uncertain:true}));
});
