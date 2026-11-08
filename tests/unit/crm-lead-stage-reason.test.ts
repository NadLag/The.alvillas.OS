import {randomUUID,randomBytes,createHash} from "node:crypto";
import {describe,expect,it} from "vitest";
import {encryptLeadStageReason,decryptLeadStageReason} from "@/modules/crm/domain/lead-stage-reason";
const env={NODE_ENV:"test" as const,ENCRYPTION_KEYS:"current:"+randomBytes(32).toString("base64")},binding={organizationId:randomUUID(),leadId:randomUUID(),revisionId:randomUUID(),createdBy:randomUUID(),commandKey:randomUUID()};
describe("private original lead stage reasons",()=>{
  it("retains exact multilingual reasons through the existing authenticated binary envelope",()=>{
    const reason="Évaluation privée — تقييم خاص",cipher=encryptLeadStageReason(reason,binding,env);expect(decryptLeadStageReason(cipher,binding,env)).toBe(reason);expect(cipher.includes(Buffer.from(reason))).toBe(false);expect(createHash("sha256").update(cipher).digest("hex")).toMatch(/^[a-f0-9]{64}$/u);
  });
  it.each(Object.keys(binding) as Array<keyof typeof binding>)("binds the encrypted original to its exact %s",key=>{
    const cipher=encryptLeadStageReason("Actual private stage correction",binding,env);expect(()=>decryptLeadStageReason(cipher,{...binding,[key]:randomUUID()},env)).toThrow();
  });
  it("retains old ciphertext through key rotation without rewriting it",()=>{
    const cipher=encryptLeadStageReason("Original immutable reason",binding,env),before=Buffer.from(cipher),rotated={...env,ENCRYPTION_KEYS:"new:"+randomBytes(32).toString("base64")+","+env.ENCRYPTION_KEYS};expect(decryptLeadStageReason(cipher,binding,rotated)).toBe("Original immutable reason");expect(Buffer.compare(cipher,before)).toBe(0);
  });
  it("refuses identity fallback or weak active keys for private reason encryption",()=>{
    for(const value of[{NODE_ENV:"test" as const,AUTH_SECRET:"identity fallback"},{...env,ENCRYPTION_KEYS:"weak:legacy"},{...env,ENCRYPTION_KEYS:undefined}])expect(()=>encryptLeadStageReason("Private original reason",binding,value)).toThrow("lead_configuration_unavailable");
  });
  it("rejects modified ciphertext and control characters instead of presenting unauthenticated text",()=>{
    const cipher=encryptLeadStageReason("Private original reason",binding,env);cipher[cipher.length-1]^=1;expect(()=>decryptLeadStageReason(cipher,binding,env)).toThrow();expect(()=>encryptLeadStageReason("unsafe\u0000reason",binding,env)).toThrow();
  });
});
