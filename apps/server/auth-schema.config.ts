import { betterAuth } from "better-auth";
import { staffAuthFields } from "./src/staff/auth-fields.ts";

export default betterAuth({
	emailAndPassword: { enabled: true },
	user: { additionalFields: staffAuthFields },
});
