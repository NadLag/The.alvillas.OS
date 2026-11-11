import {describe,expect,it} from "vitest";
import {commandFingerprint,jsonbFingerprint} from "@/platform/http/command-fingerprint";

describe("persisted JSONB source authentication",()=>{
 it("authenticates reordered object keys and nested records without changing command serialization",()=>{const left={owner:{id:"actual-owner",version:2},refs:[{key:"ops.mid_stay_threshold",id:"actual-source"}]},right={refs:[{id:"actual-source",key:"ops.mid_stay_threshold"}],owner:{version:2,id:"actual-owner"}};expect(jsonbFingerprint(left)).toBe(jsonbFingerprint(right));expect(commandFingerprint(left)).not.toBe(commandFingerprint(right));});
 it("retains array order, explicit false, zero, null and exact decimal strings",()=>{const values=[false,0,null,"9007199254740993.07"];for(const changed of[[0,false,null,"9007199254740993.07"],[false,0,null,"9007199254740993.08"],[false,0,"", "9007199254740993.07"]])expect(jsonbFingerprint(values)).not.toBe(jsonbFingerprint(changed));});
 it("rejects omitted dependencies and altered source versions rather than treating an empty manifest as complete",()=>{const source={workflowReferences:[{key:"ops.mid_stay_threshold",rule:{id:"actual-rule",version:3}}]};expect(jsonbFingerprint(source)).not.toBe(jsonbFingerprint({workflowReferences:[]}));expect(jsonbFingerprint(source)).not.toBe(jsonbFingerprint({workflowReferences:[{key:"ops.mid_stay_threshold",rule:{id:"actual-rule",version:4}}]}));});
});
