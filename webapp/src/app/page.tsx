import CallRoom from "@/components/CallRoom";

type HomeProps = {
  searchParams?: {
    room?: string;
  };
};

export default function Home({ searchParams }: HomeProps) {
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-100 via-slate-50 to-blue-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      <CallRoom initialRoomId={searchParams?.room} />
    </main>
  );
}
