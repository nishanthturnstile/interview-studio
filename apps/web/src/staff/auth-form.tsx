import { CircleAlert, LoaderCircle } from "lucide-react";
import { type ComponentProps, type FormEvent, useState } from "react";
import type { ZodType } from "zod";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export type StaffFormField = {
	name: string;
	label: string;
	type?: ComponentProps<typeof Input>["type"];
	autoComplete: string;
	description?: string;
};

function StaffField({
	field,
	message,
	clearError,
}: {
	field: StaffFormField;
	message?: string;
	clearError: () => void;
}) {
	const [showPassword, setShowPassword] = useState(false);
	const isPassword = field.type === "password";
	const passwordLabel =
		field.name === "confirmation"
			? "password confirmation"
			: field.label.toLowerCase();
	const description =
		field.description === message ? undefined : field.description;
	const descriptionId = description ? `${field.name}-description` : undefined;
	const errorId = message ? `${field.name}-error` : undefined;

	return (
		<Field data-invalid={Boolean(message)}>
			<div className="flex items-center justify-between gap-2">
				<FieldLabel htmlFor={field.name}>{field.label}</FieldLabel>
				{isPassword && (
					<Button
						variant="ghost"
						size="sm"
						type="button"
						className="-my-2"
						aria-controls={field.name}
						aria-label={`${showPassword ? "Hide" : "Show"} ${passwordLabel}`}
						onClick={() => setShowPassword((visible) => !visible)}
					>
						{showPassword ? "Hide" : "Show"}
					</Button>
				)}
			</div>
			<Input
				required
				id={field.name}
				name={field.name}
				type={showPassword ? "text" : field.type}
				autoComplete={field.autoComplete}
				autoCapitalize={
					isPassword || field.type === "email" ? "none" : undefined
				}
				spellCheck={isPassword || field.type === "email" ? false : undefined}
				className="min-h-12"
				aria-invalid={Boolean(message)}
				aria-describedby={
					[descriptionId, errorId].filter(Boolean).join(" ") || undefined
				}
				onChange={message ? clearError : undefined}
			/>
			{description && (
				<FieldDescription id={descriptionId}>{description}</FieldDescription>
			)}
			{message && <FieldError id={errorId}>{message}</FieldError>}
		</Field>
	);
}

export function StaffForm<T>({
	action,
	pendingAction,
	schema,
	fields,
	submit,
}: {
	action: string;
	pendingAction: string;
	schema: ZodType<T>;
	fields: readonly StaffFormField[];
	submit: (data: T) => Promise<string | undefined>;
}) {
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);

	async function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending) return;
		const form = event.currentTarget;
		setError("");
		const data = schema.safeParse(Object.fromEntries(new FormData(form)));
		if (!data.success) {
			const messages: Record<string, string> = {};
			for (const issue of data.error.issues) {
				const key = String(issue.path[0]);
				messages[key] ??= issue.message;
			}
			setErrors(messages);
			const first = form.elements.namedItem(Object.keys(messages)[0]);
			if (first instanceof HTMLElement) first.focus();
			return;
		}

		setErrors({});
		setPending(true);
		try {
			setError((await submit(data.data)) ?? "");
		} catch {
			setError(
				"We couldn’t complete your request. Check your connection and try again.",
			);
		} finally {
			setPending(false);
		}
	}

	return (
		<form noValidate onSubmit={onSubmit}>
			<FieldGroup className="gap-4">
				{error && (
					<Alert variant="destructive">
						<CircleAlert aria-hidden="true" />
						<AlertTitle>{error}</AlertTitle>
					</Alert>
				)}
				{fields.map((field) => (
					<StaffField
						key={field.name}
						field={field}
						message={errors[field.name]}
						clearError={() =>
							setErrors((current) => ({ ...current, [field.name]: "" }))
						}
					/>
				))}
				<Button
					size="lg"
					type="submit"
					disabled={pending}
					aria-busy={pending}
					className="mt-1 w-full"
				>
					{pending && (
						<LoaderCircle
							data-icon="inline-start"
							aria-hidden="true"
							className="motion-safe:animate-spin"
						/>
					)}
					{action}
				</Button>
				<span aria-live="polite" className="sr-only">
					{pending ? pendingAction : ""}
				</span>
			</FieldGroup>
		</form>
	);
}
