import BookingPage from "@/components/BookingPage";

// Public guest booking page. No authentication — see auth.config's public list.
export default async function Page({ params }: { params: Promise<{ tourId: string }> }) {
  const { tourId } = await params;
  return <BookingPage tourId={tourId} />;
}
