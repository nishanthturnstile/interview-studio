import {
	hrInterviewSchema,
	type InterviewListQuery,
	interviewListSchema,
} from "@studio/contracts";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { accessDenied, InterviewRequestError, interviewRequest } from "./api";

const listKey = ["hr-interviews", "list"] as const;
const listFreshness = 30_000;

function retry(failures: number, error: Error) {
	return (
		failures < 1 &&
		(!(error instanceof InterviewRequestError) || error.status >= 500)
	);
}

export function hrInterviewsQuery(filters: InterviewListQuery) {
	return queryOptions({
		queryKey: [...listKey, filters],
		queryFn: ({ signal }) => {
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(filters)) {
				if (value !== undefined && value !== "") query.set(key, String(value));
			}
			return interviewRequest(
				`/staff/interviews?${query}`,
				interviewListSchema,
				{ signal },
			);
		},
		staleTime: listFreshness,
		refetchInterval: ({ state }) =>
			accessDenied(state.error) ? false : listFreshness,
		retry,
	});
}

export function hrBookingQuery(id: string) {
	return queryOptions({
		queryKey: ["hr-interviews", "booking", id],
		queryFn: ({ signal }) =>
			interviewRequest(`/staff/interviews/${id}`, hrInterviewSchema, {
				signal,
			}),
		staleTime: 8_000,
		refetchInterval: ({ state }) =>
			!accessDenied(state.error) &&
			(state.data?.state === "scheduled" || state.data?.state === "active")
				? 8_000
				: false,
		retry,
	});
}

export async function invalidateHrInterviews(
	client: QueryClient,
	bookingId?: string,
) {
	const list = { queryKey: listKey };
	const detail = bookingId && { queryKey: hrBookingQuery(bookingId).queryKey };
	// An in-flight read may have started before the write committed.
	await Promise.all([
		client.cancelQueries(list),
		detail && client.cancelQueries(detail),
	]);
	await Promise.all([
		client.invalidateQueries(list),
		detail && client.invalidateQueries(detail),
	]);
}
