import { z } from "zod";

export const UserPresence = z.object({
  socketId: z.string(),
  userId: z.string(),
  name: z.string(),
  color: z.string(), // assigned cursor color
  cursor: z.object({ x: z.number(), y: z.number() }).optional(), // cartesian cell coords
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
  selection: z.array(z.string()).optional(), // object uids
});
export type UserPresence = z.infer<typeof UserPresence>;
