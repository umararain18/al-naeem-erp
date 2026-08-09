import { z } from "zod";

export const registerSchema = z.object({
  fullName: z.string().min(3),
  username: z.string().min(3),
  password: z.string().min(6),
});