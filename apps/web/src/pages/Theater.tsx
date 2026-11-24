import { useParams } from "react-router-dom";

export function Theater() {
  const { id } = useParams();
  return (
    <section className="theater">
      <p className="muted">Theater mode for {id} will appear here.</p>
    </section>
  );
}
