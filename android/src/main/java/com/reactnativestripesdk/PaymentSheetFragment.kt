package com.reactnativestripesdk

import android.app.Activity
import android.app.Application
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.appcompat.content.res.AppCompatResources
import androidx.core.graphics.drawable.DrawableCompat
import androidx.fragment.app.Fragment
import com.facebook.react.bridge.*
import com.reactnativestripesdk.addresssheet.AddressSheetView
import com.reactnativestripesdk.utils.*
import com.reactnativestripesdk.utils.createError
import com.reactnativestripesdk.utils.createResult
import com.stripe.android.paymentsheet.*
import kotlinx.coroutines.CompletableDeferred
import java.io.ByteArrayOutputStream
import kotlin.Exception

class PaymentSheetFragment(
  private val context: ReactApplicationContext,
  private val initPromise: Promise
) : Fragment() {
  private var paymentSheet: PaymentSheet? = null
  private var flowController: PaymentSheet.FlowController? = null
  private var paymentIntentClientSecret: String? = null
  private var setupIntentClientSecret: String? = null
  private var intentConfiguration: PaymentSheet.IntentConfiguration? = null
  private lateinit var paymentSheetConfiguration: PaymentSheet.Configuration
  private var confirmPromise: Promise? = null
  private var presentPromise: Promise? = null
  private var paymentSheetTimedOut = false
  internal val paymentSheetIntentCreationCallback = CompletableDeferred<ReadableMap>()

  override fun onCreateView(
    inflater: LayoutInflater,
    container: ViewGroup?,
    savedInstanceState: Bundle?
  ): View {
    return FrameLayout(requireActivity()).also {
      it.visibility = View.GONE
    }
  }

  override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
    super.onViewCreated(view, savedInstanceState)
    val merchantDisplayName = arguments?.getString("merchantDisplayName").orEmpty()
    if (merchantDisplayName.isEmpty()) {
      initPromise.resolve(createError(ErrorType.Failed.toString(), "merchantDisplayName cannot be empty or null."))
      return
    }
    val primaryButtonLabel = arguments?.getString("primaryButtonLabel")
    val customerId = arguments?.getString("customerId").orEmpty()
    val customerEphemeralKeySecret = arguments?.getString("customerEphemeralKeySecret").orEmpty()
    val googlePayConfig = buildGooglePayConfig(arguments?.getBundle("googlePay"))
    val allowsDelayedPaymentMethods = arguments?.getBoolean("allowsDelayedPaymentMethods")
    val billingDetailsBundle = arguments?.getBundle("defaultBillingDetails")
    val billingConfigParams = arguments?.getBundle("billingDetailsCollectionConfiguration")
    paymentIntentClientSecret = arguments?.getString("paymentIntentClientSecret").orEmpty()
    setupIntentClientSecret = arguments?.getString("setupIntentClientSecret").orEmpty()
    intentConfiguration = try {
      buildIntentConfiguration(arguments?.getBundle("intentConfiguration"))
    } catch (error: PaymentSheetException) {
      initPromise.resolve(createError(ErrorType.Failed.toString(), error))
      return
    }
    val appearance = try {
      buildPaymentSheetAppearance(arguments?.getBundle("appearance"), context)
    } catch (error: PaymentSheetAppearanceException) {
      initPromise.resolve(createError(ErrorType.Failed.toString(), error))
      return
    }

    val shippingDetails = arguments?.getBundle("defaultShippingDetails")?.let {
      AddressSheetView.buildAddressDetails(it)
    }

    val paymentOptionCallback = PaymentOptionCallback { paymentOption ->
      val result = paymentOption?.let {
        val bitmap = getBitmapFromVectorDrawable(context, it.drawableResourceId)
        val imageString = getBase64FromBitmap(bitmap)
        val option: WritableMap = WritableNativeMap()
        option.putString("label", it.label)
        option.putString("image", imageString)
        createResult("paymentOption", option)
      } ?: run {
        if (paymentSheetTimedOut) {
          paymentSheetTimedOut = false
          createError(PaymentSheetErrorType.Timeout.toString(), "The payment has timed out")
        } else {
          createError(PaymentSheetErrorType.Canceled.toString(), "The payment option selection flow has been canceled")
        }
      }
      presentPromise?.resolve(result)
    }

    val paymentResultCallback = PaymentSheetResultCallback { paymentResult ->
      if (paymentSheetTimedOut) {
        paymentSheetTimedOut = false
        resolvePaymentResult(createError(PaymentSheetErrorType.Timeout.toString(), "The payment has timed out"))
      } else {
        when (paymentResult) {
          is PaymentSheetResult.Canceled -> {
            resolvePaymentResult(createError(PaymentSheetErrorType.Canceled.toString(), "The payment flow has been canceled"))
          }
          is PaymentSheetResult.Failed -> {
            resolvePaymentResult(createError(PaymentSheetErrorType.Failed.toString(), paymentResult.error))
          }
          is PaymentSheetResult.Completed -> {
            resolvePaymentResult(WritableNativeMap())
            // Remove the fragment now, we can be sure it won't be needed again if an intent is successful
            removeFragment(context)
            paymentSheet = null
            flowController = null
          }
        }
      }
    }

    val createIntentCallback = CreateIntentCallback {  paymentMethod, shouldSavePaymentMethod ->
      val stripeSdkModule: StripeSdkModule? = context.getNativeModule(StripeSdkModule::class.java)
      if (stripeSdkModule == null || stripeSdkModule.eventListenerCount == 0) {
        return@CreateIntentCallback CreateIntentResult.Failure(
          cause = Exception("Tried to call confirmHandler, but no callback was found. Please file an issue: https://github.com/stripe/stripe-react-native/issues"),
          displayMessage = "An unexpected error occurred"
          )
      }
      val params = Arguments.createMap().apply {
        putMap("paymentMethod", mapFromPaymentMethod(paymentMethod))
        putBoolean("shouldSavePaymentMethod", shouldSavePaymentMethod)
      }

      stripeSdkModule.sendEvent(context, "onConfirmHandlerCallback", params)

      val resultFromJavascript = paymentSheetIntentCreationCallback.await()

      return@CreateIntentCallback resultFromJavascript.getString("clientSecret")?.let {
        CreateIntentResult.Success(clientSecret = it)
      } ?: run {
        val errorMap = resultFromJavascript.getMap("error")
        CreateIntentResult.Failure(
          cause = Exception(errorMap?.getString("message")),
          displayMessage = errorMap?.getString("localizedMessage")
        )
      }
    }

    val billingDetailsConfig = PaymentSheet.BillingDetailsCollectionConfiguration(
      name = mapToCollectionMode(billingConfigParams?.getString("name")),
      phone = mapToCollectionMode(billingConfigParams?.getString("phone")),
      email = mapToCollectionMode(billingConfigParams?.getString("email")),
      address = mapToAddressCollectionMode(billingConfigParams?.getString("address")),
      attachDefaultsToPaymentMethod = billingConfigParams?.getBoolean("attachDefaultsToPaymentMethod")
        ?: false
    )

    var defaultBillingDetails: PaymentSheet.BillingDetails? = null
    if (billingDetailsBundle != null) {
      val addressBundle = billingDetailsBundle.getBundle("address")
      val address = PaymentSheet.Address(
        addressBundle?.getString("city"),
        addressBundle?.getString("country"),
        addressBundle?.getString("line1"),
        addressBundle?.getString("line2"),
        addressBundle?.getString("postalCode"),
        addressBundle?.getString("state"))
      defaultBillingDetails = PaymentSheet.BillingDetails(
        address,
        billingDetailsBundle.getString("email"),
        billingDetailsBundle.getString("name"),
        billingDetailsBundle.getString("phone"))
    }

    paymentSheetConfiguration = PaymentSheet.Configuration(
      merchantDisplayName = merchantDisplayName,
      allowsDelayedPaymentMethods = allowsDelayedPaymentMethods ?: false,
      defaultBillingDetails=defaultBillingDetails,
      customer = if (customerId.isNotEmpty() && customerEphemeralKeySecret.isNotEmpty()) PaymentSheet.CustomerConfiguration(
        id = customerId,
        ephemeralKeySecret = customerEphemeralKeySecret
      ) else null,
      googlePay = googlePayConfig,
      appearance = appearance,
      shippingDetails = shippingDetails,
      primaryButtonLabel = primaryButtonLabel,
      billingDetailsCollectionConfiguration = billingDetailsConfig
    )

    if (arguments?.getBoolean("customFlow") == true) {
      flowController = if (intentConfiguration != null) {
        PaymentSheet.FlowController.create(
          this,
          paymentOptionCallback = paymentOptionCallback,
          createIntentCallback = createIntentCallback,
          paymentResultCallback = paymentResultCallback
        )
      } else {
        PaymentSheet.FlowController.create(
          this,
          paymentOptionCallback = paymentOptionCallback,
          paymentResultCallback = paymentResultCallback
        )
      }
      configureFlowController()
    } else {
      paymentSheet = if (intentConfiguration != null) {
        PaymentSheet(
          this,
          createIntentCallback = createIntentCallback,
          paymentResultCallback = paymentResultCallback
        )
      } else {
        PaymentSheet(
          this,
          callback = paymentResultCallback
        )
      }
      initPromise.resolve(WritableNativeMap())
    }
  }

  fun present(promise: Promise) {
    this.presentPromise = promise
    if(paymentSheet != null) {
      if (!paymentIntentClientSecret.isNullOrEmpty()) {
        paymentSheet?.presentWithPaymentIntent(paymentIntentClientSecret!!, paymentSheetConfiguration)
      } else if (!setupIntentClientSecret.isNullOrEmpty()) {
        paymentSheet?.presentWithSetupIntent(setupIntentClientSecret!!, paymentSheetConfiguration)
      } else if (intentConfiguration != null) {
        paymentSheet?.presentWithIntentConfiguration(
          intentConfiguration = intentConfiguration!!,
          configuration = paymentSheetConfiguration
        )
      }
    } else if(flowController != null) {
      flowController?.presentPaymentOptions()
    } else {
      promise.resolve(createMissingInitError())
    }
  }

  fun presentWithTimeout(timeout: Long, promise: Promise) {
    var paymentSheetActivity: Activity? = null

    val activityLifecycleCallbacks = object : Application.ActivityLifecycleCallbacks {
      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        paymentSheetActivity = activity
      }

      override fun onActivityStarted(activity: Activity) {}

      override fun onActivityResumed(activity: Activity) {}

      override fun onActivityPaused(activity: Activity) {}

      override fun onActivityStopped(activity: Activity) {}

      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

      override fun onActivityDestroyed(activity: Activity) {
        paymentSheetActivity = null
        context.currentActivity?.application?.unregisterActivityLifecycleCallbacks(this)
      }
    }

    Handler(Looper.getMainLooper()).postDelayed({
      paymentSheetActivity?.let {
        it.finish()
        paymentSheetTimedOut = true
      }
    }, timeout)

    context.currentActivity?.application?.registerActivityLifecycleCallbacks(activityLifecycleCallbacks)

    this.present(promise)
  }

  fun confirmPayment(promise: Promise) {
    this.confirmPromise = promise
    flowController?.confirm()
  }

  private fun configureFlowController() {
    val onFlowControllerConfigure = PaymentSheet.FlowController.ConfigCallback { _, _ ->
      val result = flowController?.getPaymentOption()?.let {
        val bitmap = getBitmapFromVectorDrawable(context, it.drawableResourceId)
        val imageString = getBase64FromBitmap(bitmap)
        val option: WritableMap = WritableNativeMap()
        option.putString("label", it.label)
        option.putString("image", imageString)
        createResult("paymentOption", option)
      } ?: run {
        WritableNativeMap()
      }
      initPromise.resolve(result)
    }

    if (!paymentIntentClientSecret.isNullOrEmpty()) {
      flowController?.configureWithPaymentIntent(
        paymentIntentClientSecret = paymentIntentClientSecret!!,
        configuration = paymentSheetConfiguration,
        callback = onFlowControllerConfigure
      )
    } else if (!setupIntentClientSecret.isNullOrEmpty()) {
      flowController?.configureWithSetupIntent(
        setupIntentClientSecret = setupIntentClientSecret!!,
        configuration = paymentSheetConfiguration,
        callback = onFlowControllerConfigure
      )
    } else if (intentConfiguration != null) {
      flowController?.configureWithIntentConfiguration(
        intentConfiguration = intentConfiguration!!,
        configuration = paymentSheetConfiguration,
        callback = onFlowControllerConfigure
      )
    } else {
      initPromise.resolve(createError(ErrorType.Failed.toString(), "One of `paymentIntentClientSecret`, `setupIntentClientSecret`, or `intentConfiguration` is required"))
      return
    }
  }

  private fun resolvePaymentResult(map: WritableMap) {
    confirmPromise?.let {
      it.resolve(map)
      confirmPromise = null
    } ?: run {
      presentPromise?.resolve(map)
    }
  }

  companion object {
    internal const val TAG = "payment_sheet_launch_fragment"

    internal fun createMissingInitError(): WritableMap {
      return createError(PaymentSheetErrorType.Failed.toString(), "No payment sheet has been initialized yet. You must call `initPaymentSheet` before `presentPaymentSheet`.")
    }

    internal fun buildGooglePayConfig(params: Bundle?): PaymentSheet.GooglePayConfiguration? {
      if (params == null) {
        return null
      }

      val countryCode = params.getString("merchantCountryCode").orEmpty()
      val currencyCode = params.getString("currencyCode").orEmpty()
      val testEnv = params.getBoolean("testEnv")

      return PaymentSheet.GooglePayConfiguration(
        environment = if (testEnv) PaymentSheet.GooglePayConfiguration.Environment.Test else PaymentSheet.GooglePayConfiguration.Environment.Production,
        countryCode = countryCode,
        currencyCode = currencyCode
      )
    }

    @Throws(PaymentSheetException::class)
    private fun buildIntentConfiguration(intentConfigurationParams: Bundle?): PaymentSheet.IntentConfiguration? {
      if (intentConfigurationParams == null) {
        return null
      }
      val modeParams = intentConfigurationParams.getBundle("mode")
              ?: throw PaymentSheetException("If `intentConfiguration` is provided, `intentConfiguration.mode` is required")

      return PaymentSheet.IntentConfiguration(
        mode = buildIntentConfigurationMode(modeParams),
        paymentMethodTypes = intentConfigurationParams.getStringArrayList("paymentMethodTypes")?.toList() ?: emptyList(),
      )
    }

    private fun buildIntentConfigurationMode(modeParams: Bundle): PaymentSheet.IntentConfiguration.Mode {
      val currencyCode = modeParams.getString("currencyCode")
        ?: throw PaymentSheetException("You must provide a value to intentConfiguration.mode.currencyCode")

      return if (modeParams.containsKey("amount")) {
        PaymentSheet.IntentConfiguration.Mode.Payment(
          amount = modeParams.getInt("amount").toLong(),
          currency = currencyCode,
          setupFutureUse = mapToSetupFutureUse(modeParams.getString("setupFutureUsage")),
          captureMethod = mapToCaptureMethod(modeParams.getString("captureMethod")),
        )
      } else {
        val setupFutureUsage = mapToSetupFutureUse(modeParams.getString("setupFutureUsage"))
          ?: throw PaymentSheetException("You must provide a value to intentConfiguration.mode.setupFutureUsage")
        PaymentSheet.IntentConfiguration.Mode.Setup(
          currency = currencyCode,
          setupFutureUse = setupFutureUsage
        )
      }
    }
  }
}

fun getBitmapFromVectorDrawable(context: Context?, drawableId: Int): Bitmap? {
  var drawable = AppCompatResources.getDrawable(context!!, drawableId) ?: return null

  drawable = DrawableCompat.wrap(drawable).mutate()
  val bitmap = Bitmap.createBitmap(drawable.intrinsicWidth, drawable.intrinsicHeight, Bitmap.Config.ARGB_8888)
  bitmap.eraseColor(Color.WHITE)
  val canvas = Canvas(bitmap)
  drawable.setBounds(0, 0, canvas.width, canvas.height)
  drawable.draw(canvas)
  return bitmap
}

fun getBase64FromBitmap(bitmap: Bitmap?): String? {
  if (bitmap == null) {
    return null
  }
  val stream = ByteArrayOutputStream()
  bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
  val imageBytes: ByteArray = stream.toByteArray()
  return Base64.encodeToString(imageBytes, Base64.DEFAULT)
}

fun mapToCollectionMode(str: String?): PaymentSheet.BillingDetailsCollectionConfiguration.CollectionMode {
  return when (str) {
    "automatic" -> PaymentSheet.BillingDetailsCollectionConfiguration.CollectionMode.Automatic
    "never" -> PaymentSheet.BillingDetailsCollectionConfiguration.CollectionMode.Never
    "always" -> PaymentSheet.BillingDetailsCollectionConfiguration.CollectionMode.Always
    else -> PaymentSheet.BillingDetailsCollectionConfiguration.CollectionMode.Automatic
  }
}

fun mapToAddressCollectionMode(str: String?): PaymentSheet.BillingDetailsCollectionConfiguration.AddressCollectionMode {
  return when (str) {
    "automatic" -> PaymentSheet.BillingDetailsCollectionConfiguration.AddressCollectionMode.Automatic
    "never" -> PaymentSheet.BillingDetailsCollectionConfiguration.AddressCollectionMode.Never
    "full" -> PaymentSheet.BillingDetailsCollectionConfiguration.AddressCollectionMode.Full
    else -> PaymentSheet.BillingDetailsCollectionConfiguration.AddressCollectionMode.Automatic
  }
}

fun mapToSetupFutureUse(type: String?): PaymentSheet.IntentConfiguration.SetupFutureUse? {
  return when (type) {
    "OffSession" ->  PaymentSheet.IntentConfiguration.SetupFutureUse.OffSession
    "OnSession" ->  PaymentSheet.IntentConfiguration.SetupFutureUse.OnSession
    else ->  null
  }
}

fun mapToCaptureMethod(type: String?): PaymentSheet.IntentConfiguration.CaptureMethod {
  return when (type) {
    "Automatic" ->  PaymentSheet.IntentConfiguration.CaptureMethod.Automatic
    "Manual" ->  PaymentSheet.IntentConfiguration.CaptureMethod.Manual
    "AutomaticAsync" ->  PaymentSheet.IntentConfiguration.CaptureMethod.AutomaticAsync
    else ->  PaymentSheet.IntentConfiguration.CaptureMethod.Automatic
  }
}
