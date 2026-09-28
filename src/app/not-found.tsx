"use client";

import { ArrowLeft, HomeLine } from "@untitledui/icons";
import { useRouter } from "next/navigation";
import { Button } from "@/components/base/buttons/button";

export default function NotFound() {
    const router = useRouter();

    return (
        <section className="flex min-h-[70dvh] items-start bg-primary py-16 md:items-center md:py-24">
            <div className="mx-auto max-w-container grow px-4 md:px-8">
                <div className="flex w-full max-w-3xl flex-col gap-8 md:gap-12">
                    <div className="flex flex-col gap-4 md:gap-6">
                        <div className="flex flex-col gap-3">
                            <span className="text-md font-semibold text-brand-secondary">Error 404</span>
                            <h1 className="text-display-md font-semibold text-primary md:text-display-lg">No encontramos esta página</h1>
                        </div>
                        <p className="text-lg text-tertiary md:text-xl">Puede que la dirección esté mal escrita o que la página ya no exista.</p>
                    </div>

                    <div className="flex flex-col-reverse gap-3 sm:flex-row">
                        <Button color="secondary" size="xl" iconLeading={ArrowLeft} onClick={() => router.back()}>
                            Volver atrás
                        </Button>
                        <Button size="xl" iconLeading={HomeLine} href="/">
                            Ir al inicio
                        </Button>
                    </div>
                </div>
            </div>
        </section>
    );
}
