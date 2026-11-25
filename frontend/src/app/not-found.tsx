import Link from "next/link";

export default function NotFound() {
  return (
    <section className="mx-auto flex max-w-lg flex-col items-center gap-4 px-6 py-24 text-center">
      <p className="font-heading text-sm font-semibold uppercase tracking-widest text-accent-purple">
        404
      </p>
      <h1 className="font-heading text-3xl font-bold text-white">Page not found</h1>
      <p className="text-slate-400">The page you requested does not exist.</p>
      <Link href="/" className="btn-primary">
        Return home
      </Link>
    </section>
  );
}
