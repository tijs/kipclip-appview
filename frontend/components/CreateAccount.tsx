function PdsOption({
  name,
  description,
  pdsUrl,
  icon,
  borderColor = "hover:border-gray-200",
}: {
  name: string;
  description: string;
  pdsUrl: string;
  icon: React.ReactNode;
  borderColor?: string;
}) {
  return (
    <a
      href={`/login?handle=${encodeURIComponent(pdsUrl)}&prompt=create`}
      className={`block bg-white rounded-lg shadow-md p-5 hover:shadow-lg transition border-2 border-transparent ${borderColor}`}
    >
      <div className="flex items-center gap-4">
        {icon}
        <div>
          <div className="font-semibold text-gray-800">{name}</div>
          <div className="text-sm text-gray-500">{description}</div>
        </div>
      </div>
    </a>
  );
}

export function CreateAccount() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2">
            <img
              src="https://res.cloudinary.com/dru3aznlk/image/upload/v1760692589/kip-vignette_h2jwct.png"
              alt="Kip logo"
              className="w-8 h-8"
            />
            <h1
              className="text-2xl font-bold"
              style={{ color: "var(--coral)" }}
            >
              kipclip
            </h1>
          </a>
          <a
            href="/"
            className="text-gray-600 hover:text-gray-800 text-sm font-medium"
          >
            Back to Home
          </a>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-12">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold text-gray-800 mb-3">
            Create your free account
          </h2>
          <p className="text-gray-600">
            Your account works across kipclip, Bluesky, and a growing number of
            apps in the Atmosphere — an open ecosystem where you own your data.
          </p>
        </div>

        <div className="space-y-4 mb-8">
          <p className="text-sm font-medium text-gray-700 text-center">
            Choose where to create your account:
          </p>

          <PdsOption
            name="Bluesky"
            description="The largest community. Great place to start."
            pdsUrl="https://bsky.social"
            borderColor="hover:border-blue-200"
            icon={
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: "#1185FF" }}
              >
                <svg
                  className="w-6 h-6 text-white"
                  viewBox="0 0 568 501"
                  fill="currentColor"
                  aria-hidden
                >
                  <path d="M123.121 33.6637C188.241 82.5526 258.281 181.681 284 234.873C309.719 181.681 379.759 82.5526 444.879 33.6637C491.866 -1.61183 568 -28.9064 568 57.9464C568 75.2916 558.055 203.659 552.222 224.501C531.947 296.954 458.067 315.434 392.347 304.249C507.222 323.8 536.444 388.56 473.333 453.32C353.473 576.312 301.061 422.461 287.631 383.039C285.169 375.812 284.017 372.431 284 375.306C283.983 372.431 282.831 375.812 280.369 383.039C266.939 422.461 214.527 576.312 94.6667 453.32C31.5556 388.56 60.7778 323.8 175.653 304.249C109.933 315.434 36.0533 296.954 15.7778 224.501C9.94525 203.659 0 75.2916 0 57.9464C0 -28.9064 76.1345 -1.61183 123.121 33.6637Z" />
                </svg>
              </div>
            }
          />

          <PdsOption
            name="Margin"
            description="Community PDS, open to everyone."
            pdsUrl="https://margin.cafe"
            icon={
              <div className="w-12 h-12 rounded-full bg-amber-700 flex items-center justify-center flex-shrink-0">
                <span className="text-white text-lg font-bold">M</span>
              </div>
            }
          />
        </div>

        <details className="mb-8 text-sm text-gray-500">
          <summary className="cursor-pointer font-medium text-gray-600 hover:text-gray-800">
            What happens when I choose?
          </summary>
          <div className="mt-2 space-y-2">
            <p>
              You'll be taken to your chosen server to create an account. Once
              you're done, you'll be brought right back to kipclip, already
              signed in.
            </p>
            <p>
              Your account isn't tied to kipclip — it works across all
              Atmosphere apps.
            </p>
          </div>
        </details>

        <div className="text-center">
          <p className="text-sm text-gray-500">
            Already have an account?{" "}
            <a href="/" className="underline hover:text-gray-700">
              Sign in
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
