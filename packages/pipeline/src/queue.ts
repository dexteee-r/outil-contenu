/**
 * File de travaux du worker : un seul traitement à la fois (rendu, appels API), dans l'ordre
 * d'arrivée. Partagée par la surveillance de /raw et les actions du tableau de bord (feedback,
 * reprise, miniatures), qui tournent dans le même processus.
 */
export class JobQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly waiting: string[] = [];
  private running: { label: string; since: string } | null = null;

  /** Ajoute un travail ; la promesse se résout avec son résultat quand il a tourné. */
  run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.waiting.push(label);
    const job = this.tail.then(async () => {
      this.waiting.shift();
      this.running = { label, since: new Date().toISOString() };
      try {
        return await fn();
      } finally {
        this.running = null;
      }
    });
    this.tail = job.catch(() => undefined);
    return job;
  }

  /** Ce qui tourne et ce qui attend (pour le tableau de bord). */
  status(): { current: { label: string; since: string } | null; waiting: string[] } {
    return { current: this.running, waiting: [...this.waiting] };
  }

  /** Attend que tout ce qui a été ajouté jusqu'ici soit terminé. */
  async idle(): Promise<void> {
    await this.tail;
  }
}
