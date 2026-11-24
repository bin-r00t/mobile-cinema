import { useParams } from "react-router-dom";

export function MovieDetail() {
  const { id } = useParams();
  return (
    <section className="page page-detail">
      <h1>Movie</h1>
      <p className="muted">Details for {id} will appear here.</p>
    </section>
  );
}
