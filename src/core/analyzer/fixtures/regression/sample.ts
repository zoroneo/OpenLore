export class Repository<T> {
  private items: T[] = [];

  add(item: T): void {
    this.validate(item);
    this.items.push(item);
  }

  private validate(item: T): void {
    if (item == null) throw new Error('null item');
  }

  async findAll(): Promise<T[]> {
    return this.load();
  }

  private async load(): Promise<T[]> {
    return this.items;
  }
}

export function createRepo<T>(): Repository<T> {
  return new Repository<T>();
}

function bootstrap(): void {
  const repo = createRepo<string>();
  repo.add('hello');
}

bootstrap();
