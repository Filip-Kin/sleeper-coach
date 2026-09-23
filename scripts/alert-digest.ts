// The `alert-digest` scheduled job: one 09:00 ET push with everything that
// was recorded at digest level (or muted by the hourly budget) since the last
// one. Runs as its own process like every other job, so a dead HA cannot
// stall the daemon.
import { sendDigest } from "../src/alert.ts";

const sent = await sendDigest();
console.log(sent ? `[digest] sent ${sent.count} alert(s): ${sent.title}` : "[digest] nothing pending");
