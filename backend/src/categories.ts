import { z } from "zod";

export const categorySlugSchema = z
  .string()
  .max(40)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
