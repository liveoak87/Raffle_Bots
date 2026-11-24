import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/database";
import { getForumTopicName, resolveTemplateThreadId } from "../src/forumTopics";
import { rememberForumTopicFromMessage } from "../src/topicCache";
import { handleRecurringPostFailure } from "../src/recurring";
import { createRaffle, GROUP } from "./workflowHarness";
describe("production topic and recurring behavior", () => {
 beforeEach(() => db.initDatabase(":memory:")); afterEach(() => db.getDb().close());
 it("keeps the default topic name current after a rename and ignores stale nested names", () => {
   db.upsertGroupDefaults(GROUP,{thread_id:123,thread_name:"Original"});
   rememberForumTopicFromMessage(GROUP,{message_id:123,message_thread_id:123,forum_topic_edited:{name:"Renamed"}});
   rememberForumTopicFromMessage(GROUP,{message_id:124,message_thread_id:123,reply_to_message:{forum_topic_created:{name:"Original"}}});
   expect(db.getGroupDefaults(GROUP)?.thread_name).toBe("Renamed");
   expect(db.getForumTopicName(GROUP,123)).toBe("Renamed");
 });
 it("resolves nested topic names and preserves explicit destinations", () => {
   expect(getForumTopicName({message_id:1,reply_to_message:{forum_topic_created:{name:"Raffles"}}})).toBe("Raffles");
   expect(resolveTemplateThreadId(123,456)).toBe(123);
   expect(resolveTemplateThreadId(null,456)).toBe(456);
 });
 it("removes failed recurring posts, pauses the template, and reports notification failure", async () => {
   const r=createRaffle(10);
   const template=db.createTemplate({chat_id:GROUP,thread_id:123,creator_id:10,name:"daily",title:"Daily",prize:"Prize",prizes:null,max_entries:null,max_winners:1,duration_minutes:60,sponsor_name:null,anonymous:0,recurring_interval_minutes:60});
   db.setRecurringActive(template.id,true,"2000-01-01 00:00:00");
   const api={sendMessage:vi.fn().mockRejectedValue(new Error("offline"))};
   expect(await handleRecurringPostFailure(api,template,r.id,"Raffles")).toBe(false);
   expect(db.getRaffleById(r.id)).toBeUndefined();
   expect(db.getTemplateById(template.id)).toMatchObject({recurring_active:0,next_run_at:null});
 });
});
